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
    released: true, releasing: false, question: null, retiredIds: [], pendingFork: null, external: false,
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

const DELAY = 30 * 60_000;
const MINUTE = 60_000;

/** A window, unfocused since `NOW`, after a snapshot at `NOW` for each of `states`. */
function windowAfter(...states: WorkItemView[][]): DoneWindow {
  const window = new DoneWindow(FILE, WINDOWS, false, NOW);

  states.forEach((items) => window.update(snapshot(items), NOW));

  return window;
}

/** Whether the window closes once the delay has passed since `NOW`. */
const closesLater = (window: DoneWindow): boolean => window.close(false, NOW + DELAY, DELAY);

describe('DoneWindow', () => {
  it('closes once, after its work has been done and the window unfocused for the delay', () => {
    const window = windowAfter([item()], [done('idle')]);

    expect(window.closeAt(DELAY)).toBe(NOW + DELAY);
    expect(window.close(false, NOW + DELAY - 1, DELAY)).toBe(false);
    expect(window.close(false, NOW + DELAY, DELAY)).toBe(true);
    expect(window.close(false, NOW + DELAY, DELAY)).toBe(false);
    expect(window.closeAt(DELAY)).toBeNull();
  });

  it('closes at once with no delay', () => {
    expect(windowAfter([item()], [done()]).close(false, NOW, 0)).toBe(true);
  });

  it('counts the delay from when the window lost focus, when that is later than the work becoming done', () => {
    const window = new DoneWindow(FILE, WINDOWS, true, NOW);

    window.update(snapshot([item()]), NOW);
    window.update(snapshot([done()]), NOW);
    expect(window.closeAt(DELAY)).toBeNull();
    expect(window.close(false, NOW + DELAY, DELAY)).toBe(false);
    window.focus(false, NOW + 10 * MINUTE);
    expect(window.close(false, NOW + DELAY, DELAY)).toBe(false);
    expect(window.close(false, NOW + 10 * MINUTE + DELAY, DELAY)).toBe(true);
  });

  it('counts the delay from when the work became done, when that is later than the window losing focus', () => {
    const window = new DoneWindow(FILE, WINDOWS, false, NOW);

    window.update(snapshot([item()]), NOW);
    window.update(snapshot([done()]), NOW + 10 * MINUTE);
    window.update(snapshot([done()]), NOW + 20 * MINUTE);
    expect(window.closeAt(DELAY)).toBe(NOW + 10 * MINUTE + DELAY);
  });

  it('restarts the delay when the window is focused, and keeps the first blur of an unfocused window', () => {
    const window = windowAfter([item()], [done()]);

    window.focus(true, NOW + 29 * MINUTE);
    expect(window.close(false, NOW + DELAY, DELAY)).toBe(false);
    window.focus(false, NOW + 40 * MINUTE);
    window.focus(false, NOW + 50 * MINUTE);
    expect(window.closeAt(DELAY)).toBe(NOW + 40 * MINUTE + DELAY);
  });

  it('restarts the delay when its work item opens again and becomes done again', () => {
    const window = windowAfter([item()], [done()]);

    window.update(snapshot([item({ status: 'blocked', sessions: [session(1, 'ended')] })]), NOW + 5 * MINUTE);
    expect(window.closeAt(DELAY)).toBeNull();
    window.update(snapshot([done()]), NOW + 20 * MINUTE);
    expect(window.closeAt(DELAY)).toBe(NOW + 20 * MINUTE + DELAY);
  });

  it('closes when the session process has ended or its turn failed', () => {
    expect(closesLater(windowAfter([item()], [done('ended')]))).toBe(true);
    expect(closesLater(windowAfter([item()], [done('failed')]))).toBe(true);
  });

  it('waits for a session that reported done to end its turn, and counts the delay from then', () => {
    const window = windowAfter([item()], [done('running')]);

    expect(window.closeAt(DELAY)).toBeNull();
    window.update(snapshot([done('waiting')]), NOW + MINUTE);
    expect(window.closeAt(DELAY)).toBeNull();
    window.update(snapshot([done('idle')]), NOW + 2 * MINUTE);
    expect(window.closeAt(DELAY)).toBe(NOW + 2 * MINUTE + DELAY);
  });

  it('waits for a session that is starting, even an earlier one', () => {
    expect(closesLater(windowAfter([item()], [done('idle', { sessions: [session(1, 'starting'), session(2, 'idle')] })]))).toBe(false);
  });

  it('waits while holding unsaved changes, then closes', () => {
    const window = windowAfter([item()], [done()]);

    expect(window.close(true, NOW + DELAY, DELAY)).toBe(false);
    expect(window.close(false, NOW + DELAY, DELAY)).toBe(true);
  });

  it('never closes a window opened on work that was already done', () => {
    expect(closesLater(windowAfter([done()], [done()]))).toBe(false);
  });

  it('waits until every work item that uses the window is done', () => {
    const earlier = done('ended', { id: 6 });
    const window = windowAfter([earlier, item()]);

    expect(closesLater(window)).toBe(false);
    window.update(snapshot([earlier, done()]), NOW);
    expect(closesLater(window)).toBe(true);
  });

  it('stays open when an open work item moves to another window and leaves only work that was already done', () => {
    const earlier = done('ended', { id: 6 });
    const moved = item({ sessions: [session(1, 'idle'), { ...session(2, 'running'), cwd: 'D:/git/widgets' }] });

    expect(closesLater(windowAfter([earlier, item()], [earlier, moved]))).toBe(false);
  });

  it("ignores another window's work items and a window with none", () => {
    const other = item({ id: 8, worktree: { id: 2, ticketId: 8, path: 'D:/git/widgets/.worktrees/108-other', branch: '108-other', linkedBy: 'report' }, sessions: [] });

    expect(closesLater(windowAfter([item(), other], [item(), { ...other, status: 'done' }]))).toBe(false);
    expect(closesLater(windowAfter([item()], []))).toBe(false);
  });

  it('does nothing in a window that is not an item window', () => {
    const window = new DoneWindow(null, WINDOWS, false, NOW);

    window.update(snapshot([item()]), NOW);
    window.update(snapshot([done()]), NOW);
    expect(closesLater(window)).toBe(false);
  });
});