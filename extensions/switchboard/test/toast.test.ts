import type { Snapshot, WorkItemView } from '@switchboard/hub';
import { describe, expect, it } from 'vitest';
import { NeedsYouTracker, newlyNeeding, toastOf } from '../src/toast.js';

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
    released: false,
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
    warning: null,
    error: null,
    failedStep: null,
    unassignedAt: null,
    queuedAt: null,
    approvalPrompt: null,
    approvalSummary: null,
    approvalReport: null,
    createdAt: NOW,
    statusAt: NOW,
    runStartedAt: NOW,
    scopeAt: null,
    doneAt: null,
    doneReason: null,
    parentId: null,
    pastes: [],
    parent: null,
    approvalSends: false,
    ticket: { id, source: 'github', sourceKey: String(100 + id), ref: `#${100 + id}`, sourceId: null, title: `Issue ${id}`, url: `https://github.com/o/r/issues/${100 + id}`, assigned: true, pool: false, snoozed, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: NOW, repoRoot: '' },
    triage: null,
    sessions: [],
    worktree: null,
    links: [],
    returned: 0,
    ...patch,
  };
}

function snapshot(items: WorkItemView[]): Snapshot {
  return {
    workItems: items,
    pool: [],
    playbooks: [],
    repoRoots: [],
    sources: ['github'],
    sourceStates: [{ name: 'github', enabled: true }],
    namespaces: { github: 'dev' },
    configDir: 'C:\\Users\\me\\.switchboard',
    errors: { settings: null, playbooks: [], hooks: null, sources: {} },
  };
}

const ids = (items: WorkItemView[]) => items.map((entry) => entry.id);

describe('newlyNeeding', () => {
  it('returns nothing for the first snapshot of a connection, however many items need the operator', () => {
    expect(newlyNeeding(null, snapshot([item(1, 'blocked'), item(2, 'awaiting-approval')]))).toEqual([]);
  });

  it('returns each item that entered Needs you since the previous snapshot, and not one that was already there', () => {
    const before = snapshot([item(1, 'blocked'), item(2, 'running'), item(3, 'running'), item(4, 'queued')]);
    const after = snapshot([item(1, 'blocked'), item(2, 'awaiting-approval'), item(3, 'running', { sessions: [session({ state: 'waiting' })] }), item(4, 'running'), item(5, 'failed')]);

    expect(ids(newlyNeeding(before, after))).toEqual([2, 3, 5]);
  });

  it('returns an item again when it leaves Needs you and returns', () => {
    const first = snapshot([item(1, 'blocked')]);
    const left = snapshot([item(1, 'running')]);
    const back = snapshot([item(1, 'awaiting-approval')]);

    expect(ids(newlyNeeding(first, left))).toEqual([]);
    expect(ids(newlyNeeding(left, back))).toEqual([1]);
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

describe('NeedsYouTracker', () => {
  it('returns nothing for each connection\'s first snapshot, including an item that started needing the operator while disconnected', () => {
    const tracker = new NeedsYouTracker();

    tracker.connected();
    expect(ids(tracker.update(snapshot([item(1, 'blocked')])))).toEqual([]);
    expect(ids(tracker.update(snapshot([item(1, 'blocked'), item(2, 'failed')])))).toEqual([2]);

    tracker.connected();
    expect(ids(tracker.update(snapshot([item(1, 'blocked'), item(2, 'failed'), item(3, 'awaiting-approval')])))).toEqual([]);
    expect(ids(tracker.update(snapshot([item(1, 'blocked'), item(2, 'failed'), item(3, 'awaiting-approval'), item(4, 'failed')])))).toEqual([4]);
  });
});

describe('toastOf', () => {
  it('names the ticket and what the operator must do, and offers Open when the row has an open action', () => {
    const ended = session({ state: 'ended', endedAt: NOW, released: true });

    expect(toastOf(item(1, 'awaiting-approval', { sessions: [ended] }))).toEqual({ message: 'Switchboard: Issue 1 — Review, then approve', open: true });
    expect(toastOf(item(2, 'running', { sessions: [session({ state: 'waiting' })] }))).toEqual({ message: 'Switchboard: Issue 2 — Answer a question', open: true });
    expect(toastOf(item(3, 'blocked', { sessions: [ended] }))).toEqual({ message: 'Switchboard: Issue 3 — Blocked', open: true });
  });

  it('offers no Open when the row has nothing to open, such as a failed ad-hoc start', () => {
    const adhoc = item(4, 'failed', { sessions: [session({ nativeSessionId: null, shortId: null, state: 'ended', released: true })] });

    adhoc.ticket = { ...adhoc.ticket, source: 'adhoc', url: '', title: 'Tidy the logs' };

    expect(toastOf(adhoc)).toEqual({ message: 'Switchboard: Tidy the logs — Failed', open: false });
  });
});
