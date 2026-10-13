import type { Snapshot, WorkItemView } from '@switchboard/hub';
import type { Session, SessionState } from '@switchboard/core';
import { describe, expect, it } from 'vitest';
import { DoneWindow } from '../src/doneWindow.js';

const NOW = Date.UTC(2026, 9, 10, 12);
const WINDOWS = 'C:\\Users\\me\\.switchboard\\windows';
const WORKTREE = 'D:/git/widgets/.worktrees/107-fix';
const FILE = `${WINDOWS}\\gh-107-58c609.code-workspace`;

function session(id: number, state: SessionState): Session {
  return {
    id: `s-${id}`,
    workItemId: 7,
    kind: 'task',
    provider: 'claude',
    nativeSessionId: `s-${id}`,
    shortId: null,
    cwd: WORKTREE,
    state,
    stateAt: NOW,
    stateDetail: null,
    outcome: null,
    outcomeDetail: null,
    startedAt: NOW,
    endedAt: null,
    released: true, releasing: false, question: null,
    reports: ['done'],
  };
}

function item(patch: Partial<WorkItemView> = {}): WorkItemView {
  return {
    id: 7,
    ticketId: 7,
    playbook: 'dev:develop',
    status: 'running',
    stage: null,
    stageAt: null,
    taskPrompt: null,
    guidance: null,
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
    readyAt: null,
    orderAt: null,
    scopeAt: null,
    doneAt: null,
    doneReason: null,
    parentId: null,
    pastes: [],
    parent: null,
    approvalSends: false,
    waits: [],
    ticket: { id: 7, source: 'github', sourceKey: '107', ref: '#107', sourceId: null, title: 'Issue 7', url: 'https://github.com/o/r/issues/107', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: NOW, repoRoot: '' },
    triage: null,
    focus: null,
    sessions: [session(1, 'running')],
    worktree: { id: 1, ticketId: 7, path: WORKTREE, branch: '107-fix', linkedBy: 'report' },
    links: [],
    returned: 0,
    ...patch,
  };
}

const done = (state: SessionState = 'idle', patch: Partial<WorkItemView> = {}): WorkItemView => item({ status: 'done', doneAt: NOW, doneReason: 'session', sessions: [session(1, state)], ...patch });

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

function windowAfter(...states: WorkItemView[][]): DoneWindow {
  const window = new DoneWindow(FILE, WINDOWS);

  states.forEach((items) => window.update(snapshot(items)));

  return window;
}

describe('DoneWindow', () => {
  it('closes once when its work item becomes done while it is open and its session has ended its turn', () => {
    const window = windowAfter([item()], [done('idle')]);

    expect(window.close(false, false)).toBe(true);
    expect(window.close(false, false)).toBe(false);
  });

  it('closes when the session process has ended or its turn failed', () => {
    expect(windowAfter([item()], [done('ended')]).close(false, false)).toBe(true);
    expect(windowAfter([item()], [done('failed')]).close(false, false)).toBe(true);
  });

  it('waits for a session that reported done to end its turn', () => {
    const window = windowAfter([item()], [done('running')]);

    expect(window.close(false, false)).toBe(false);
    window.update(snapshot([done('waiting')]));
    expect(window.close(false, false)).toBe(false);
    window.update(snapshot([done('idle')]));
    expect(window.close(false, false)).toBe(true);
  });

  it('waits for a session that is starting, even an earlier one', () => {
    const window = windowAfter([item()], [done('idle', { sessions: [session(1, 'starting'), session(2, 'idle')] })]);

    expect(window.close(false, false)).toBe(false);
  });

  it('waits while focused or holding unsaved changes, then closes', () => {
    const window = windowAfter([item()], [done()]);

    expect(window.close(true, false)).toBe(false);
    expect(window.close(false, true)).toBe(false);
    expect(window.close(false, false)).toBe(true);
  });

  it('never closes a window opened on work that was already done', () => {
    const window = windowAfter([done()], [done()]);

    expect(window.close(false, false)).toBe(false);
  });

  it('waits until every work item that uses the window is done', () => {
    const earlier = done('ended', { id: 6 });
    const window = windowAfter([earlier, item()]);

    expect(window.close(false, false)).toBe(false);
    window.update(snapshot([earlier, done()]));
    expect(window.close(false, false)).toBe(true);
  });

  it('stays open when an open work item moves to another window and leaves only work that was already done', () => {
    const earlier = done('ended', { id: 6 });
    const moved = item({ sessions: [session(1, 'idle'), { ...session(2, 'running'), cwd: 'D:/git/widgets' }] });
    const window = windowAfter([earlier, item()], [earlier, moved]);

    expect(window.close(false, false)).toBe(false);
  });

  it('stays open when its work item opens again before it closes', () => {
    const window = windowAfter([item()], [done()], [item({ status: 'blocked', sessions: [session(1, 'ended')] })]);

    expect(window.close(false, false)).toBe(false);
  });

  it("ignores another window's work items and a window with none", () => {
    const other = item({ id: 8, worktree: { id: 2, ticketId: 8, path: 'D:/git/widgets/.worktrees/108-other', branch: '108-other', linkedBy: 'report' }, sessions: [] });
    const window = windowAfter([item(), other], [item(), { ...other, status: 'done' }]);

    expect(window.close(false, false)).toBe(false);
    expect(windowAfter([item()], []).close(false, false)).toBe(false);
  });

  it('does nothing in a window that is not an item window', () => {
    const window = new DoneWindow(null, WINDOWS);

    window.update(snapshot([item()]));
    window.update(snapshot([done()]));
    expect(window.close(false, false)).toBe(false);
  });
});
