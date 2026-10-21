import { describe, expect, it } from 'vitest';
import type { FlowAction, PolledTicket } from '../src/flow.js';
import { Harness, T0, playbooks } from './flowHarness.js';

/** A Zoho ticket: in the pool, assigned to the operator, or neither. Its R ref shows that the source, not core, chooses the reference. */
function zoho(key: string, state: 'pool' | 'assigned' | 'neither', sortAt = Number(key)): PolledTicket {
  return { sourceKey: key, ref: `R${key}`, sourceId: `id-${key}`, title: `Case ${key}`, url: `https://desk.example.test/${key}`, assigned: state === 'assigned', pool: state === 'pool', sortAt, enteredAt: null };
}

function only<T extends FlowAction['type']>(actions: FlowAction[], type: T): Extract<FlowAction, { type: T }> {
  expect(actions).toHaveLength(1);
  expect(actions[0]?.type).toBe(type);
  return actions[0] as Extract<FlowAction, { type: T }>;
}

const pollZoho = (h: Harness, ...tickets: PolledTicket[]) => h.act({ type: 'poll', source: 'zoho', tickets });

const ZOHO_PLAYBOOKS = playbooks(undefined, { 'support:case': { description: 'A Support case', autoStart: true, workdir: 'repoRoot', template: '/support-process {{ticket.ref}}' } });

describe('pool triage (PRD R47, R50)', () => {
  it('triages a ticket entering the pool, offering only its namespace, stores its rating, and creates no work item', () => {
    const h = new Harness({ playbooks: ZOHO_PLAYBOOKS });
    const triage = only(pollZoho(h, zoho('500', 'pool'), zoho('501', 'neither')), 'triage');

    expect(triage).toMatchObject({ workItemId: null, systemPrompt: 'Triage the Support case.\n\nChoose one playbook:\n- support:defect: Research a defect\n- support:case: A Support case', choices: [{ name: 'support:defect', description: 'Research a defect' }, { name: 'support:case', description: 'A Support case' }], rates: true });
    expect(h.store.workItem(1)).toBeNull();

    h.act({ type: 'triage-succeeded', triageId: triage.triageId, context: 'ctx', playbook: 'support:case', immediacy: 'BLOCKING', severity: 'MED', model: null, links: [{ label: 'PR', target: 'https://github.com/o/r/pull/2' }] });

    expect(h.store.linksFor(1)).toMatchObject([{ ticketId: 1, label: 'PR', target: 'https://github.com/o/r/pull/2' }]);
    expect(h.store.poolTriages(1)).toMatchObject([{ ticketId: 1, workItemId: null, playbook: 'support:case', immediacy: 'BLOCKING', severity: 'MED' }]);
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

  it('fails a pool triage at once when the triage playbook uses a variable other than {{playbooks}}', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'triage:zoho': { description: 'Zoho triage', kind: 'triage', template: '{{ticket.title}}\n{{playbooks}}' } }) });

    expect(pollZoho(h, zoho('500', 'pool'))).toEqual([]);
    expect(h.store.poolTriages(1)).toMatchObject([{ error: 'Triage playbook triage:zoho: Unknown template variable: ticket.title.', endedAt: T0 }]);
  });

  it('keeps the Support triage when a ticket leaves the pool and reuses it if it returns', () => {
    const h = new Harness({ playbooks: ZOHO_PLAYBOOKS });
    const triage = only(pollZoho(h, zoho('500', 'pool')), 'triage');
    h.act({ type: 'triage-succeeded', triageId: triage.triageId, context: 'ctx', playbook: 'support:case', immediacy: null, severity: null, model: null });

    pollZoho(h);
    expect(h.store.ticket(1)).toMatchObject({ pool: false, assigned: false });
    expect(h.store.poolTriages(1)).toMatchObject([{ playbook: 'support:case' }]);

    expect(pollZoho(h, zoho('500', 'pool'))).toEqual([]);
  });

  it('lists pool tickets oldest first', () => {
    const h = new Harness({ playbooks: ZOHO_PLAYBOOKS });
    pollZoho(h, zoho('502', 'pool', 3), zoho('500', 'pool', 1), zoho('501', 'pool', 2), zoho('503', 'neither'));

    expect(h.store.poolTickets().map((ticket) => ticket.sourceKey)).toEqual(['500', '501', '502']);
  });
});

describe('pick (PRD R48)', () => {
  const MANUAL = playbooks(undefined, { 'support:case': { description: 'A Support case', workdir: 'repoRoot', template: '/support-process {{ticket.ref}}' } });

  function pooled(h: Harness, key = '500', playbook: string | null = 'support:case'): number {
    const triage = only(pollZoho(h, zoho(key, 'pool')), 'triage');

    if (playbook !== null) {
      h.act({ type: 'triage-succeeded', triageId: triage.triageId, context: 'ctx', playbook, immediacy: null, severity: null, model: null });
    } else {
      h.act({ type: 'triage-failed', triageId: triage.triageId, error: 'x', context: null });
    }

    return h.store.findTicket('zoho', key)!.id;
  }

  it('starts the pool triage playbook in the repo root without Approve, even when the playbook does not auto-start', () => {
    const h = new Harness({ playbooks: MANUAL });
    const ticketId = pooled(h);
    const start = only(h.act({ type: 'pick', ticketId }), 'start-session');

    expect(start).toMatchObject({ kind: 'task', cwd: 'D:/git/support', name: 'switchboard · support:case · zoho 500', permissionMode: 'auto', model: null });
    expect(start.prompt).toBe('/support-process R500');
    expect(h.item(1)).toMatchObject({ ticketId, status: 'running', playbook: 'support:case' });
    expect(h.store.triagesFor(1)).toMatchObject([{ ticketId, workItemId: 1, playbook: 'support:case' }]);
    expect(h.send({ type: 'pick', ticketId }).refused).toBe('The ticket already has a work item.');
  });

  it('makes no second work item when the claim shows on the next poll, and a reopened assigned ticket waits for Start', () => {
    const h = new Harness({ playbooks: MANUAL });
    h.started(only(h.act({ type: 'pick', ticketId: pooled(h) }), 'start-session'));

    expect(pollZoho(h, zoho('500', 'assigned'))).toEqual([]);
    expect(h.store.workItem(2)).toBeNull();
    expect(h.item(1).status).toBe('running');

    const reopened = only(pollZoho(h, zoho('500', 'assigned'), zoho('600', 'assigned')), 'triage');
    expect(h.act({ type: 'triage-succeeded', triageId: reopened.triageId, context: 'c', playbook: 'support:case', immediacy: null, severity: null, model: null })).toEqual([]);
    expect(h.item(2).status).toBe('unstarted');
  });

  it('finishes a picked work item whose session ends without a report', () => {
    const h = new Harness({ playbooks: MANUAL });
    h.started(only(h.act({ type: 'pick', ticketId: pooled(h) }), 'start-session'));

    h.act({ type: 'roster', sessions: [] });
    expect(h.item(1)).toMatchObject({ status: 'finished', error: null, readyAt: h.now });
  });

  it('refuses a pick of a ticket not in the pool or without a triage result', () => {
    const h = new Harness({ playbooks: MANUAL });
    pollZoho(h, zoho('501', 'neither'));

    expect(h.send({ type: 'pick', ticketId: 1 }).refused).toBe('The ticket is not in the pool.');
    expect(h.send({ type: 'pick', ticketId: 99 }).refused).toBe('The ticket is not in the pool.');

    const running = only(pollZoho(h, zoho('501', 'neither'), zoho('502', 'pool')), 'triage');
    const ticketId = h.store.findTicket('zoho', '502')!.id;
    expect(h.send({ type: 'pick', ticketId }).refused).toBe('The ticket has no triage result yet.');

    h.act({ type: 'triage-failed', triageId: running.triageId, error: 'x', context: null });
    expect(h.send({ type: 'pick', ticketId }).refused).toBe('The ticket has no triage result yet.');
    expect(h.store.workItem(1)).toBeNull();
  });
});
