import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { MESSAGES, playbookChoices } from '../src/flow.js';
import { Harness, issue, playbooks, settings } from './flowHarness.js';

const OTHER = { 'dev:other': { description: 'Work out what the ticket needs', reports: ['playbook'], template: '/sb-route {{ticket.sourceKey}}' } };

function triage(action: FlowAction | undefined): Extract<FlowAction, { type: 'triage' }> {
  if (action?.type !== 'triage') {
    throw new Error(`Expected a triage action, got ${JSON.stringify(action)}`);
  }

  return action;
}

/** Triages issue 1 to dev:question, which waits for Start. */
function unstarted(h: Harness): void {
  h.triaged(h.poll(issue('1'))[0], 'dev:question');
  expect(h.status(1)).toBe('unstarted');
}

describe('Start with guidance… chooses the playbook (PRD R35)', () => {
  it("starts with the chosen playbook in place of triage's, and logs it with the start", () => {
    const h = new Harness();
    unstarted(h);

    // dev:develop requires a worktree, which the ticket lacks, so the start runs setup first.
    expect(h.act({ type: 'start', workItemId: 1, guidance: '', playbook: 'dev:develop' })).toMatchObject([{ type: 'start-session', kind: 'setup', prompt: expect.stringMatching(/^\/init-worktree 1/) }]);
    expect(h.item(1)).toMatchObject({ status: 'setup', playbook: 'dev:develop', guidance: null });
    expect(h.store.ticketHistory(1)!.events.find((event) => event.type === 'start')).toMatchObject({ actor: 'operator', detail: { playbook: 'dev:develop' } });
  });

  it("keeps triage's playbook for a start without one or with the same one, and logs no playbook for the first", () => {
    for (const playbook of [undefined, null, 'dev:question']) {
      const h = new Harness();
      unstarted(h);

      expect(h.act({ type: 'start', workItemId: 1, ...(playbook === undefined ? {} : { playbook }) })).toMatchObject([{ type: 'start-session', kind: 'task' }]);
      expect(h.item(1).playbook).toBe('dev:question');
    }

    const h = new Harness();
    unstarted(h);
    h.act({ type: 'start', workItemId: 1 });
    expect(h.store.ticketHistory(1)!.events.find((event) => event.type === 'start')!.detail).toBeNull();
  });

  it('clears the Nothing is newer reason when it starts with another playbook (PRD R80)', () => {
    const h = new Harness();
    const action = triage(h.poll(issue('1'))[0]);
    h.act({ type: 'triage-succeeded', triageId: action.triageId, context: 'Context 1', playbook: 'dev:question', immediacy: null, severity: null, model: null, stale: true });
    expect(h.item(1)).toMatchObject({ status: 'unstarted', error: MESSAGES.nothingNew });

    h.act({ type: 'start', workItemId: 1, playbook: 'dev:develop' });
    expect(h.item(1)).toMatchObject({ playbook: 'dev:develop', error: null });
  });

  it('refuses another namespace, a triage playbook and an unknown name, and neither starts nor changes the work item', () => {
    for (const playbook of ['support:defect', 'triage:github', 'dev:missing']) {
      const h = new Harness();
      unstarted(h);

      expect(h.send({ type: 'start', workItemId: 1, guidance: 'Be brief.', playbook }).refused).toBe(`${playbook} is not a task playbook in the dev namespace.`);
      expect(h.item(1)).toMatchObject({ status: 'unstarted', playbook: 'dev:question', guidance: null });
    }
  });

  it('starts a pool pick with the chosen playbook, and refuses one outside the namespace (PRD R48)', () => {
    const h = new Harness();
    const action = triage(h.act({ type: 'poll', source: 'github', tickets: [{ ...issue('1', false), pool: true }] })[0]);
    h.act({ type: 'triage-succeeded', triageId: action.triageId, context: 'Context 1', playbook: 'dev:question', immediacy: null, severity: null, model: null });

    expect(h.send({ type: 'pick', ticketId: 1, playbook: 'support:defect' }).refused).toBe('support:defect is not a task playbook in the dev namespace.');
    expect(h.store.workItemsForTicket(1)).toEqual([]);

    h.act({ type: 'pick', ticketId: 1, playbook: 'dev:develop' });
    expect(h.store.workItemsForTicket(1)).toMatchObject([{ playbook: 'dev:develop' }]);
  });

  it("offers the namespace's task playbooks in settings order, and none without a playbook or for a scheduled run", () => {
    const all = playbooks(undefined, OTHER);

    expect(playbookChoices('dev:question', 'github', all)).toEqual(['dev:develop', 'dev:question', 'dev:other']);
    expect(playbookChoices('support:defect', 'zoho', all)).toEqual(['support:defect']);
    expect(playbookChoices(null, 'adhoc', all)).toEqual([]);
    expect(playbookChoices('ops:review', 'schedule', all)).toEqual([]);
  });

  it("refuses another playbook for an ad-hoc work item and a scheduled run, which keeps its schedule's", () => {
    const adhoc = new Harness();
    adhoc.act({ type: 'adhoc', prompt: 'Write hello.txt', repoRoot: 'D:/scratch' });

    expect(adhoc.send({ type: 'start', workItemId: 1, playbook: 'dev:question' }).refused).toBe('The playbook of this work item cannot change.');
    expect(adhoc.item(1)).toMatchObject({ status: 'unstarted', playbook: null });

    const ops = { 'ops:review': { description: 'Measure review outcomes', reports: ['done'], template: '/performance-self-review' }, 'ops:other': { description: 'Other', template: 'x' } };
    const scheduled = new Harness({ settings: settings({ schedules: { review: { playbook: 'ops:review', repoRoot: 'D:/git/research', every: 'day', day: null, at: 9 * 60 } } }), playbooks: playbooks(undefined, ops) });
    // ops:review does not start automatically, so its 09:00 run waits for Start.
    scheduled.now = new Date(2026, 9, 15, 8).getTime();
    scheduled.act({ type: 'tick' });
    scheduled.now = new Date(2026, 9, 15, 9, 1).getTime();
    scheduled.act({ type: 'tick' });
    const run = scheduled.store.workItemsForTicket(scheduled.store.findTicket('schedule', 'review')!.id)[0]!;
    expect(run.status).toBe('unstarted');

    expect(scheduled.send({ type: 'start', workItemId: run.id, playbook: 'ops:other' }).refused).toBe('The playbook of this work item cannot change.');
    expect(scheduled.item(run.id)).toMatchObject({ status: 'unstarted', playbook: 'ops:review' });
  });
});
