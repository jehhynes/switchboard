import type { PoolView, Snapshot, WorkItemView } from '../src/runtime.js';

// Fixtures for the row and dock views, which build from a panel snapshot.

export const NOW = Date.UTC(2026, 9, 3, 12);

export type Session = WorkItemView['sessions'][number];
export type Triage = NonNullable<WorkItemView['triage']>;

export function session(patch: Partial<Session> = {}): Session {
  return {
    id: 's1',
    workItemId: 1,
    kind: 'task',
    provider: 'claude',
    nativeSessionId: 'aaaa1111-native',
    shortId: 'aaaa1111',
    cwd: 'D:/git/widgets',
    state: 'running',
    stateAt: NOW,
    stateDetail: null,
    outcome: null,
    outcomeDetail: null,
    startedAt: NOW - 5 * 60_000,
    endedAt: null,
    released: false, releasing: false, question: null,
    reports: ['stage', 'done', 'link'],
    ...patch,
  };
}

export function item(id: number, patch: Partial<WorkItemView> = {}): WorkItemView {
  return {
    id,
    ticketId: id,
    playbook: 'dev:develop',
    status: 'running',
    stage: null,
    stageAt: null,
    taskPrompt: null,
    warning: null,
    error: null,
    unassignedAt: null,
    queuedAt: null,
    approvalPrompt: null,
    approvalSummary: null,
    approvalReport: null,
    approvalHeld: false,
    createdAt: NOW,
    statusAt: NOW,
    runStartedAt: NOW,
    readyAt: patch.status === 'awaiting-approval' || patch.status === 'finished' ? NOW : null,
    orderAt: null,
    scopeAt: null,
    doneAt: null,
    doneReason: null,
    parentId: null,
    ticket: { id, source: 'github', sourceKey: String(100 + id), ref: `#${100 + id}`, sourceId: null, title: `Issue <${id}>`, url: `https://github.com/o/r/issues/${100 + id}`, assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: NOW, repoRoot: '' },
    triage: null,
    sessions: [],
    worktree: null,
    links: [],
    pastes: [],
    returned: 0,
    parent: null,
    approvalSends: false,
    waits: [],
    question: null,
    ...patch,
  };
}

export function snapshot(items: WorkItemView[], patch: Partial<Snapshot> = {}): Snapshot {
  return {
    workItems: items,
    pool: [],
    playbooks: [
      { name: 'dev:develop', description: 'Build it' },
      { name: 'support:defect', description: 'Research a defect' },
    ],
    repoRoots: ['D:/git/widgets', 'D:/git/support'],
    sources: ['github'],
    sourceStates: [{ name: 'github', enabled: true }],
    namespaces: { github: 'dev', zoho: 'support', adhoc: '' },
    configDir: 'C:\\Users\\me\\.claude\\switchboard',
    errors: { settings: null, playbooks: [], hooks: null, sources: {} },
    ...patch,
  };
}

export function triage(patch: Partial<Triage> = {}): Triage {
  return { id: 1, ticketId: 1, workItemId: 1, context: 'Issue text', playbook: 'dev:develop', immediacy: null, severity: null, model: null, startedAt: NOW, endedAt: NOW, error: null, ...patch };
}

export function pool(id: number, patch: Partial<PoolView> = {}): PoolView {
  return { ticket: { ...item(id).ticket, assigned: false, pool: true }, triage: triage({ ticketId: id, workItemId: null }), links: [], returned: 0, ...patch };
}
