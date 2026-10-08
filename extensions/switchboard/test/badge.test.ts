import type { Snapshot, WorkItemView } from '@switchboard/hub';
import { describe, expect, it } from 'vitest';
import { needsBadge, needsCount } from '../src/badge.js';

type Session = WorkItemView['sessions'][number];

function session(state: Session['state']): Session {
  return {
    id: 's1',
    workItemId: 1,
    kind: 'task',
    provider: 'claude',
    nativeSessionId: 'aaaa1111-native',
    shortId: 'aaaa1111',
    cwd: 'D:/git/widgets',
    state,
    stateAt: 0,
    stateDetail: null,
    outcome: null,
    outcomeDetail: null,
    startedAt: 0,
    endedAt: null,
    released: false,
    reports: [],
  };
}

function item(id: number, status: WorkItemView['status'], patch: { snoozed?: boolean; sessions?: Session[] } = {}): WorkItemView {
  return {
    id,
    ticketId: id,
    playbook: 'dev:develop',
    status,
    stage: null,
    stageAt: null,
    taskPrompt: null,
    warning: null,
    error: null,
    failedStep: null,
    unassignedAt: null,
    queuedAt: null,
    approvalPrompt: null,
    approvalSummary: null,
    approvalReport: null,
    approvalHeld: false,
    createdAt: 0,
    statusAt: 0,
    runStartedAt: 0,
    scopeAt: null,
    doneAt: null,
    doneReason: null,
    parentId: null,
    pastes: [],
    parent: null,
    approvalSends: false,
    waits: [],
    ticket: { id, source: 'github', sourceKey: String(id), ref: `#${id}`, sourceId: null, title: `Issue ${id}`, url: `https://github.com/o/r/issues/${id}`, assigned: true, pool: false, snoozed: patch.snoozed ?? false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: 0, repoRoot: '' },
    triage: null,
    sessions: patch.sessions ?? [],
    worktree: null,
    links: [],
    returned: 0,
  };
}

function snapshot(workItems: WorkItemView[]): Snapshot {
  return {
    workItems,
    pool: [],
    playbooks: [],
    repoRoots: [],
    sources: [],
    sourceStates: [],
    namespaces: {},
    configDir: '',
    errors: { settings: null, playbooks: [], hooks: null, sources: {} },
  };
}

describe('needsCount (PRD R64)', () => {
  it('counts approvals, blocks, failures and waiting sessions, and nothing in another group', () => {
    const items = [
      item(1, 'awaiting-approval'),
      item(2, 'blocked'),
      item(3, 'failed'),
      item(4, 'running', { sessions: [session('waiting')] }),
      item(5, 'running', { sessions: [session('running')] }),
      item(6, 'queued'),
      item(7, 'unstarted'),
      item(8, 'triaging'),
      item(9, 'done'),
    ];

    expect(needsCount(snapshot(items))).toBe(4);
  });

  it('leaves out a snoozed work item that would need the operator', () => {
    expect(needsCount(snapshot([item(1, 'failed', { snoozed: true }), item(2, 'blocked')]))).toBe(1);
  });

  it('is 0 for an empty snapshot', () => {
    expect(needsCount(snapshot([]))).toBe(0);
  });
});

describe('needsBadge (PRD R64)', () => {
  it('shows the count with a singular or plural tooltip', () => {
    expect(needsBadge(snapshot([item(1, 'failed')]))).toEqual({ value: 1, tooltip: '1 needs you' });
    expect(needsBadge(snapshot([item(1, 'failed'), item(2, 'blocked')]))).toEqual({ value: 2, tooltip: '2 need you' });
  });

  it('clears the badge when nothing needs the operator', () => {
    expect(needsBadge(snapshot([item(1, 'running'), item(2, 'failed', { snoozed: true })]))).toBeUndefined();
  });
});
