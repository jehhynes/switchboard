import type { Session, Ticket, Triage } from '@switchboard/core';
import { describe, expect, it } from 'vitest';
import { cardsOf } from '../src/cards.js';
import type { PoolView, Snapshot, WorkItemView } from '../src/runtime.js';

function ticket(id: number, source: string, url: string, snoozed = false): Ticket {
  return { id, source, sourceKey: String(id), ref: `#${id}`, sourceId: null, title: `t${id}`, url, assigned: true, pool: false, snoozed, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' };
}

function session(state: Session['state']): Session {
  return { id: 's', workItemId: 0, kind: 'task', provider: 'claude', nativeSessionId: null, shortId: null, cwd: '', state, stateAt: 0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 0, endedAt: null, released: false, reports: [] };
}

function item(id: number, owner: Ticket, status: WorkItemView['status'], playbook: string | null, sessions: Session[] = []): WorkItemView {
  return {
    id, ticketId: owner.id, playbook, status, stage: null, stageAt: null, taskPrompt: null, warning: null, error: null, failedStep: null, unassignedAt: null, queuedAt: null,
    approvalPrompt: null, approvalSummary: null, approvalReport: null, createdAt: 0, statusAt: 0, runStartedAt: null, scopeAt: null, doneAt: null, doneReason: null, parentId: null,
    ticket: owner, triage: null, sessions, worktree: null, links: [], pastes: [], returned: 0, parent: null, approvalSends: false, waits: [],
  };
}

function triage(playbook: string | null, endedAt: number | null, error: string | null = null): Triage {
  return { id: 1, ticketId: 0, workItemId: null, context: null, playbook, immediacy: null, severity: null, model: null, startedAt: 0, endedAt, error };
}

function snapshot(workItems: WorkItemView[], pool: PoolView[], sources: string[]): Snapshot {
  return { workItems, pool, playbooks: [], repoRoots: [], sources, sourceStates: [], namespaces: { github: 'dev', zoho: 'support' }, configDir: '', errors: { settings: null, playbooks: [], hooks: null, sources: {} } };
}

const issue = (n: number) => `https://github.com/o/r/issues/${n}`;

describe('cardsOf', () => {
  it('gives each work item of a polled source its playbook and panel group', () => {
    const cards = cardsOf(
      snapshot(
        [
          item(1, ticket(1, 'github', issue(1)), 'awaiting-approval', 'dev:review-pr'),
          item(2, ticket(2, 'github', issue(2)), 'running', 'dev:qa-failure', [session('waiting')]),
          item(3, ticket(3, 'github', issue(3), true), 'running', 'dev:new-dev', [session('running')]),
          item(4, ticket(4, 'github', issue(4)), 'triaging', null),
          item(5, ticket(5, 'github', issue(5)), 'done', 'dev:other'),
          item(6, ticket(6, 'github', issue(6)), 'failed', null),
        ],
        [],
        ['github'],
      ),
    );

    expect(cards).toEqual([
      { url: issue(1), playbook: 'dev:review-pr', group: 'needs', mark: 'review', snoozed: false, links: [] },
      { url: issue(2), playbook: 'dev:qa-failure', group: 'needs', mark: 'question', snoozed: false, links: [] },
      { url: issue(3), playbook: 'dev:new-dev', group: 'working', mark: 'running', snoozed: true, links: [] },
      { url: issue(4), playbook: 'dev:triage', group: 'unstarted', mark: 'triaging', snoozed: false, links: [] },
      { url: issue(5), playbook: 'dev:other', group: 'done', mark: 'done-session', snoozed: false, links: [] },
      { url: issue(6), playbook: null, group: 'needs', mark: 'failed', snoozed: false, links: [] },
    ]);
  });

  it('shows a ticket as its open work item, otherwise its latest one', () => {
    const returning = ticket(1, 'github', issue(1));
    const finished = ticket(2, 'github', issue(2));
    const cards = cardsOf(
      snapshot(
        [
          item(1, returning, 'done', 'dev:review-pr'),
          item(4, returning, 'unstarted', 'dev:review-pr-followup'),
          item(3, returning, 'done', 'dev:other'),
          item(5, finished, 'done', 'dev:new-dev'),
          item(2, finished, 'done', 'dev:other'),
        ],
        [],
        ['github'],
      ),
    );

    expect(cards).toEqual([
      { url: issue(1), playbook: 'dev:review-pr-followup', group: 'unstarted', mark: null, snoozed: false, links: [] },
      { url: issue(2), playbook: 'dev:new-dev', group: 'done', mark: 'done-session', snoozed: false, links: [] },
    ]);
  });

  it('leaves out tickets of sources not polled and tickets with no URL', () => {
    const cards = cardsOf(
      snapshot(
        [
          item(1, ticket(1, 'github', issue(1)), 'running', 'dev:new-dev'),
          item(2, ticket(2, 'forum', 'https://forum.example.test/t/2'), 'running', 'support:case'),
          item(3, ticket(3, 'adhoc', ''), 'running', null),
        ],
        [],
        ['github', 'adhoc'],
      ),
    );

    expect(cards).toEqual([{ url: issue(1), playbook: 'dev:new-dev', group: 'working', mark: 'running', snoozed: false, links: [] }]);
  });

  it('shows a pool ticket as Unstarted with its triage\'s playbook, over its done work items', () => {
    const picked = ticket(1, 'zoho', 'https://desk.example.test/1', true);
    const cards = cardsOf(
      snapshot(
        [item(1, picked, 'done', 'support:defect')],
        [
          { ticket: picked, triage: triage('support:case', 10), links: [], returned: 1 },
          { ticket: ticket(2, 'zoho', 'https://desk.example.test/2'), triage: triage(null, null), links: [], returned: 0 },
          { ticket: ticket(3, 'zoho', 'https://desk.example.test/3'), triage: triage(null, 10, 'Model refused'), links: [], returned: 0 },
          { ticket: ticket(4, 'zoho', 'https://desk.example.test/4', true), triage: null, links: [], returned: 0 },
          { ticket: ticket(5, 'zoho', ''), triage: triage('support:case', 10), links: [], returned: 0 },
        ],
        ['zoho'],
      ),
    );

    expect(cards).toEqual([
      { url: 'https://desk.example.test/1', playbook: 'support:case', group: 'unstarted', mark: null, snoozed: true, links: [] },
      { url: 'https://desk.example.test/2', playbook: 'support:triage', group: 'unstarted', mark: 'triaging', snoozed: false, links: [] },
      { url: 'https://desk.example.test/3', playbook: null, group: 'unstarted', mark: null, snoozed: false, links: [] },
      { url: 'https://desk.example.test/4', playbook: null, group: 'unstarted', mark: null, snoozed: true, links: [] },
    ]);
  });

  it("gives a card the link URLs of its work item or pool entry (PRD R69)", () => {
    const linked = ticket(1, 'github', issue(1));
    const pooled = ticket(2, 'zoho', 'https://desk.example.test/2');
    const link = (target: string) => ({ id: 1, ticketId: 0, label: 'PR', target, reportedAt: 0 });
    const withLinks = (entry: WorkItemView, targets: string[]): WorkItemView => ({ ...entry, links: targets.map(link) });
    const cards = cardsOf(
      snapshot(
        [withLinks(item(1, linked, 'running', 'dev:develop'), ['https://github.com/o/r/pull/7', 'https://example.test/doc']), withLinks(item(2, pooled, 'done', 'support:defect'), ['https://github.com/o/r/issues/8'])],
        [{ ticket: pooled, triage: triage('support:case', 10), returned: 1, links: [link('https://github.com/o/r/issues/9')] }],
        ['github', 'zoho'],
      ),
    );

    expect(cards).toEqual([
      { url: issue(1), playbook: 'dev:develop', group: 'working', mark: 'running', snoozed: false, links: ['https://github.com/o/r/pull/7', 'https://example.test/doc'] },
      { url: 'https://desk.example.test/2', playbook: 'support:case', group: 'unstarted', mark: null, snoozed: false, links: ['https://github.com/o/r/issues/9'] },
    ]);
  });
});
