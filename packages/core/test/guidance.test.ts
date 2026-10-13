import { describe, expect, it } from 'vitest';
import type { FlowAction, PolledTicket } from '../src/flow.js';
import { Harness, issue, playbooks, settings } from './flowHarness.js';

function only<T extends FlowAction['type']>(actions: FlowAction[], type: T): Extract<FlowAction, { type: T }> {
  expect(actions).toHaveLength(1);
  expect(actions[0]?.type).toBe(type);
  return actions[0] as Extract<FlowAction, { type: T }>;
}

/** Triages issue 1 to dev:question, which waits for Start. */
function unstarted(h: Harness): void {
  h.triaged(h.poll(issue('1'))[0], 'dev:question');
  expect(h.status(1)).toBe('unstarted');
}

const GUIDED = 'Answer Issue 1.\nContext 1\n\nCheck the 2024 thread first.\nKeep it short.';

describe('Start with guidance (PRD R77)', () => {
  it('ends the task prompt with the trimmed guidance, keeps it in taskPrompt and clears it once the session starts', () => {
    const h = new Harness();
    unstarted(h);

    const start = only(h.act({ type: 'start', workItemId: 1, guidance: '  Check the 2024 thread first.\nKeep it short.\n' }), 'start-session');

    expect(start.prompt).toBe(GUIDED);
    expect(h.item(1)).toMatchObject({ status: 'running', taskPrompt: GUIDED, guidance: null });
  });

  it('starts with the playbook prompt alone for blank or missing guidance', () => {
    for (const guidance of [undefined, null, '', ' \n\t']) {
      const h = new Harness();
      unstarted(h);

      expect(only(h.act({ type: 'start', workItemId: 1, ...(guidance === undefined ? {} : { guidance }) }), 'start-session').prompt).toBe('Answer Issue 1.\nContext 1');
    }
  });

  it('keeps the guidance while the start waits for a slot', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 0 } }) });
    unstarted(h);

    expect(h.act({ type: 'start', workItemId: 1, guidance: 'Be brief.' })).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'queued', guidance: 'Be brief.' });

    h.settings = settings({ sessions: { concurrency: 1 } });
    expect(only(h.act({ type: 'tick' }), 'start-session').prompt).toBe('Answer Issue 1.\nContext 1\n\nBe brief.');
    expect(h.item(1).guidance).toBeNull();
  });

  it('does not fill a {{session.id}} the guidance contains', () => {
    const h = new Harness();
    unstarted(h);

    expect(only(h.act({ type: 'start', workItemId: 1, guidance: 'Quote {{session.id}} as typed.' }), 'start-session').prompt).toMatch(/Quote \{\{session\.id\}\} as typed\.$/);
  });

  it('holds the guidance through a setup session and gives it to the task session only', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'dev:build': { description: 'Build', requiresWorktree: true, reports: ['done', 'worktree'], template: '/gc-plan {{ticket.sourceKey}}' } }) });
    h.triaged(h.poll(issue('1'))[0], 'dev:build');

    const setup = only(h.act({ type: 'start', workItemId: 1, guidance: 'Skip the UI.' }), 'start-session');

    expect(setup).toMatchObject({ kind: 'setup', prompt: '/init-worktree 1' });
    expect(h.item(1).guidance).toBe('Skip the UI.');

    const session = h.started(setup);
    h.report(session, { kind: 'worktree', path: 'D:/wt/1', branch: '1-x' });
    const task = only(h.act({ type: 'roster', sessions: [] }), 'start-session');

    expect(task).toMatchObject({ kind: 'task', prompt: '/gc-plan 1\n\nSkip the UI.' });
    expect(h.item(1).guidance).toBeNull();
  });

  it('drops guidance a failed setup never used when the operator triages again', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'dev:build': { description: 'Build', requiresWorktree: true, reports: ['done', 'worktree'], template: '/gc-plan {{ticket.sourceKey}}' } }) });
    h.triaged(h.poll(issue('1'))[0], 'dev:build');
    h.started(only(h.act({ type: 'start', workItemId: 1, guidance: 'Skip the UI.' }), 'start-session'));
    h.act({ type: 'roster', sessions: [] });
    expect(h.item(1)).toMatchObject({ status: 'failed', guidance: 'Skip the UI.' });

    const triage = only(h.act({ type: 'retriage', workItemId: 1 }), 'triage');

    expect(h.item(1).guidance).toBeNull();
    h.act({ type: 'worktree-found', source: 'github', sourceKey: '1', path: 'D:/wt/1', branch: '1-x' });
    expect(only(h.triaged(triage, 'dev:develop'), 'start-session')).toMatchObject({ kind: 'task', prompt: '/gc-plan 1' });
  });

  it('runs an approved prompt without the guidance', () => {
    const h = new Harness();
    unstarted(h);
    const session = h.started(only(h.act({ type: 'start', workItemId: 1, guidance: 'Be brief.' }), 'start-session'));

    h.report(session, { kind: 'approval', prompt: '/review-pr pr:1 publish', summary: 'post the review', report: null });
    h.act({ type: 'roster', sessions: [] });

    expect(only(h.act({ type: 'approve', workItemId: 1 }), 'start-session').prompt).toBe('/review-pr pr:1 publish');
  });

  it("adds the guidance to a reported task's prompt without changing the prompt a repeated report is matched on", () => {
    const h = new Harness();
    const parent = h.started(only(h.triaged(h.poll(issue('1'))[0], 'support:defect'), 'start-session'));
    h.report(parent, { kind: 'task', prompt: 'Fix the flaky test', repo: null, title: null });

    const start = only(h.act({ type: 'start', workItemId: 2, guidance: 'Only store.test.ts.' }), 'start-session');

    expect(start.prompt).toBe('Fix the flaky test\n\nOnly store.test.ts.');
    expect(h.item(2).taskPrompt).toBe('Fix the flaky test');
  });

  it('records the guidance in the start event, and none for a plain Start', () => {
    const h = new Harness();
    const [first, second] = h.poll(issue('1'), issue('2'));
    h.triaged(first, 'dev:question');
    h.triaged(second, 'dev:question');

    h.act({ type: 'start', workItemId: 1, guidance: ' Be brief. ' });
    h.act({ type: 'start', workItemId: 2 });

    expect(h.store.ticketHistory(1)!.events.at(-1)).toMatchObject({ type: 'start', detail: { guidance: 'Be brief.' } });
    expect(h.store.ticketHistory(2)!.events.at(-1)).toMatchObject({ type: 'start', detail: null });
  });
});

describe('pick with guidance (PRD R48, R77)', () => {
  const zoho = (key: string): PolledTicket => ({ sourceKey: key, ref: `R${key}`, sourceId: null, title: `Case ${key}`, url: `https://desk.example.test/${key}`, assigned: false, pool: true, sortAt: null, enteredAt: null });

  it("ends the picked work item's task prompt with the guidance", () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'support:case': { description: 'A Support case', workdir: 'repoRoot', template: '/support-process {{ticket.ref}}' } }) });
    const triage = only(h.act({ type: 'poll', source: 'zoho', tickets: [zoho('500')] }), 'triage');
    h.act({ type: 'triage-succeeded', triageId: triage.triageId, context: 'ctx', playbook: 'support:case', immediacy: null, severity: null, model: null });

    const start = only(h.act({ type: 'pick', ticketId: 1, guidance: 'Reply in Spanish.' }), 'start-session');

    expect(start.prompt).toBe('/support-process R500\n\nReply in Spanish.');
    expect(h.item(1).guidance).toBeNull();
    expect(h.store.ticketHistory(1)!.events.find((event) => event.type === 'pick')).toMatchObject({ detail: { guidance: 'Reply in Spanish.' } });
  });
});
