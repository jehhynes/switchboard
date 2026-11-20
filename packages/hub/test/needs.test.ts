import { describe, expect, it } from 'vitest';
import { needsMessage, newlyNeeding } from '../src/needs.js';
import type { Snapshot, WorkItemView } from '../src/snapshot.js';

const NOW = Date.UTC(2026, 9, 7, 12);

type Session = WorkItemView['sessions'][number];

function session(patch: Partial<Session> = {}): Session {
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
    released: false, releasing: false, question: null, retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null,
    reports: ['stage', 'done', 'link'],
    ...patch,
  };
}

function item(id: number, status: WorkItemView['status'], patch: Partial<WorkItemView> = {}, snoozed = false): WorkItemView {
  return {
    id,
    ticketId: id,
    playbook: 'dev:develop',
    status,
    stage: null,
    stageAt: null,
    taskPrompt: null,
    guidance: null,
    reportedPrompt: null,
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
    readyAt: status === 'awaiting-approval' || status === 'finished' ? NOW : null,
    orderAt: null,
    scopeAt: null,
    doneAt: null,
    doneReason: null,
    parentId: null,
    pastes: [],
    comments: [],
    parent: null,
    moved: false,
    approvalSends: false,
    reopenable: false,
    playbookChoices: [],
    waits: [],
    ticket: { id, source: 'github', sourceKey: String(100 + id), ref: `#${100 + id}`, repo: '', sourceId: null, title: `Issue ${id}`, url: `https://github.com/o/r/issues/${100 + id}`, assigned: true, pool: false, snoozed, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: NOW, repoRoot: '', adhocKey: null, blockers: [] },
    triage: null,
    focus: null,
    sessions: [],
    worktree: null,
    links: [],
    returned: 0,
    unread: 0,
    ...patch,
  };
}

function snapshot(items: WorkItemView[]): Snapshot {
  return {
    workItems: items,
    pool: [],
    playbooks: [],
    repoRoots: [],
    schedules: [],
    sources: ['github'],
    sourceStates: [{ name: 'github', kind: 'github', enabled: true }],
    namespaces: { github: 'dev' },
    configDir: 'C:\\Users\\me\\.switchboard',
    openVSCode: 'always',
    openTerminal: 'vscode',
    errors: { settings: null, playbooks: [], hooks: null, sources: {} },
  };
}

const ids = (items: WorkItemView[]) => items.map((entry) => entry.id);

describe('newlyNeeding', () => {
  it('returns nothing for the first snapshot of a connection, however many items need the operator', () => {
    expect(newlyNeeding(null, snapshot([item(1, 'blocked'), item(2, 'awaiting-approval')]))).toEqual([]);
  });

  it("returns each item that became the operator's turn since the previous snapshot, and not one that was already there", () => {
    const before = snapshot([item(1, 'blocked'), item(2, 'running'), item(3, 'running'), item(4, 'queued'), item(6, 'running')]);
    const after = snapshot([
      item(1, 'blocked'),
      item(2, 'awaiting-approval'),
      item(3, 'running', { sessions: [session({ state: 'waiting' })] }),
      item(4, 'running'),
      item(5, 'failed'),
      item(6, 'finished'),
    ]);

    expect(ids(newlyNeeding(before, after))).toEqual([2, 3, 5, 6]);
  });

  it("returns an item again when its turn leaves the operator and returns", () => {
    const first = snapshot([item(1, 'blocked')]);
    const left = snapshot([item(1, 'running')]);
    const back = snapshot([item(1, 'awaiting-approval')]);

    expect(ids(newlyNeeding(first, left))).toEqual([]);
    expect(ids(newlyNeeding(left, back))).toEqual([1]);
  });

  it('skips an item that held an approval while its resumed session ran, unless its ticket wakes from a snooze', () => {
    const held = { approvalHeld: true, approvalPrompt: '/publish' };
    const running = snapshot([item(1, 'running', held), item(2, 'running', held), item(3, 'running', held, true), item(4, 'running', held)]);
    const back = snapshot([
      item(1, 'awaiting-approval', { approvalPrompt: '/publish' }),
      item(4, 'blocked', { approvalPrompt: '/publish' }),
      item(2, 'running', { ...held, sessions: [session({ state: 'waiting' })] }),
      item(3, 'running', { ...held, sessions: [session({ state: 'waiting' })] }),
    ]);

    expect(ids(newlyNeeding(running, back))).toEqual([3]);
    // Without a held approval, the same return notifies.
    expect(ids(newlyNeeding(snapshot([item(1, 'running')]), snapshot([item(1, 'awaiting-approval', { approvalPrompt: '/publish' })])))).toEqual([1]);
  });

  it('skips a snoozed item until it wakes', () => {
    const before = snapshot([item(1, 'running')]);
    const snoozed = snapshot([item(1, 'blocked', {}, true)]);
    const woken = snapshot([item(1, 'blocked')]);

    expect(ids(newlyNeeding(before, snoozed))).toEqual([]);
    expect(ids(newlyNeeding(snoozed, woken))).toEqual([1]);
  });

  it('ignores items in other groups', () => {
    const before = snapshot([]);
    const after = snapshot([item(1, 'unstarted'), item(2, 'triaging'), item(3, 'running'), item(4, 'done')]);

    expect(newlyNeeding(before, after)).toEqual([]);
  });
});

describe('needsMessage', () => {
  it('names the ticket and what the operator must do', () => {
    const ended = session({ state: 'ended', endedAt: NOW, released: true });

    expect(needsMessage(item(1, 'awaiting-approval', { sessions: [ended] }))).toBe('Switchboard: Issue 1 — Review, then approve');
    expect(needsMessage(item(2, 'running', { sessions: [session({ state: 'waiting' })] }))).toBe('Switchboard: Issue 2 — Answer a question');
    expect(needsMessage(item(3, 'blocked', { sessions: [ended] }))).toBe('Switchboard: Issue 3 — Blocked');
  });
});
