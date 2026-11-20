import { describe, expect, it } from 'vitest';
import { activeSession, adhocLabel, failedAtTriage, groupOf, holdsSlot, markOf, needsYou, reviewOrder, triageLabel, turnOf, urlKey } from '../src/group.js';
import type { DoneReason, SessionOutcome, SessionState, WorkItemStatus } from '../src/model.js';

const item = (status: WorkItemStatus, ...states: SessionState[]) => ({
  status,
  readyAt: null as number | null,
  sessions: states.map((state) => ({ state, outcome: null as SessionOutcome | null })),
  triage: null as { error: string | null } | null,
});
/** A work item whose latest triage failed (PRD R34). */
const triageFailed = (status: WorkItemStatus, readyAt: number | null = null) => ({ ...item(status), readyAt, triage: { error: 'Timed out.' } });
/** A work item whose latest session Open in Claude stopped (PRD R70). */
const opened = (status: WorkItemStatus) => ({ ...item(status), sessions: [{ state: 'ended' as SessionState, outcome: 'opened' as SessionOutcome | null }] });
const ready = (status: WorkItemStatus, ...states: SessionState[]) => ({ ...item(status, ...states), readyAt: 1000 });

describe('groupOf', () => {
  it('checks Done, then Unstarted, then Ready for review, then Blocked on you, then In progress (PRD R27)', () => {
    expect(groupOf(item('done', 'waiting'))).toBe('done');
    expect(groupOf(ready('done'))).toBe('done');
    expect(groupOf(item('triaging'))).toBe('unstarted');
    expect(groupOf(item('unstarted'))).toBe('unstarted');
    expect(groupOf(item('queued'))).toBe('unstarted');
    expect(['blocked', 'failed'].map((status) => groupOf(item(status as WorkItemStatus)))).toEqual(['blocked', 'blocked']);
    // A ready work item stays in Ready for review through a block, a failure and a question.
    expect(['blocked', 'failed'].map((status) => groupOf(ready(status as WorkItemStatus)))).toEqual(['review', 'review']);
    expect(groupOf(item('running', 'ended', 'waiting'))).toBe('blocked');
    expect(groupOf(ready('awaiting-approval', 'waiting'))).toBe('review');
    expect(groupOf(item('queued', 'waiting'))).toBe('blocked');
    expect(groupOf(opened('running'))).toBe('blocked');
    expect(groupOf({ ...opened('awaiting-approval'), readyAt: 1000 })).toBe('review');
    expect(groupOf(opened('done'))).toBe('done');
    // Approve while the slots are full, or Retry, moves on from the opened question.
    expect(groupOf({ ...opened('queued'), readyAt: 1000 })).toBe('review');
    expect(groupOf(opened('queued'))).toBe('unstarted');
    expect(['awaiting-approval', 'finished', 'running', 'setup', 'queued'].map((status) => groupOf(ready(status as WorkItemStatus, 'running')))).toEqual([
      'review',
      'review',
      'review',
      'review',
      'review',
    ]);
    expect(['setup', 'running'].map((status) => groupOf(item(status as WorkItemStatus, 'ended', 'running')))).toEqual(['progress', 'progress']);
  });

  it('keeps a work item that failed at triage in Unstarted, ready or not, and a failure after triage in Blocked on you (PRD R27)', () => {
    expect(failedAtTriage(triageFailed('failed'))).toBe(true);
    expect(failedAtTriage(triageFailed('triaging'))).toBe(false);
    expect(failedAtTriage({ ...item('failed'), triage: { error: null } })).toBe(false);
    expect(failedAtTriage(item('failed'))).toBe(false);
    expect(groupOf(triageFailed('failed'))).toBe('unstarted');
    expect(groupOf(triageFailed('failed', 1000))).toBe('unstarted');
    expect(groupOf({ ...item('failed'), triage: { error: null } })).toBe('blocked');
    expect(groupOf({ ...ready('failed'), triage: { error: null } })).toBe('review');
  });
});

describe('turnOf', () => {
  it('leaves an idle hosted conversation open without a running mark or an agent turn', () => {
    for (const state of ['idle', 'ended'] as const) {
      const hosted = { ...item('running', state), sessions: [{ state, outcome: null, promptless: true }], doneReason: null, approvalSends: false, ticket: { snoozed: false } };
      expect(groupOf(hosted)).toBe('progress');
      expect(markOf(hosted)).toBe('idle');
      expect(turnOf(hosted)).toBeNull();
      expect(markOf({ ...hosted, sessions: [{ state: 'running', outcome: null, promptless: true }] })).toBe('running');
      expect(turnOf({ ...hosted, sessions: [{ state: 'running', outcome: null, promptless: true }] })).toBe('agent');
      expect(markOf({ ...hosted, sessions: [{ state: 'waiting', outcome: null, promptless: true }] })).toBe('question');
      expect(markOf({ ...hosted, status: 'blocked' })).toBe('blocked');
      expect(markOf({ ...hosted, status: 'done' })).toBe('done-session');
      expect(markOf({ ...hosted, sessions: [{ state, outcome: null, promptless: false }] })).toBe('running');
    }
  });
  it("is the operator's in Blocked on you and on work awaiting review, else the agent's, and none outside the active groups (PRD R27)", () => {
    expect(turnOf(item('failed'))).toBe('operator');
    expect(turnOf(item('running', 'waiting'))).toBe('operator');
    expect(turnOf(ready('awaiting-approval'))).toBe('operator');
    expect(turnOf(ready('finished'))).toBe('operator');
    expect(['blocked', 'failed'].map((status) => turnOf(ready(status as WorkItemStatus)))).toEqual(['operator', 'operator']);
    expect(turnOf(ready('running', 'waiting'))).toBe('operator');
    expect(turnOf(ready('running', 'running'))).toBe('agent');
    expect(turnOf(ready('queued'))).toBe('agent');
    expect(turnOf(item('running', 'running'))).toBe('agent');
    expect(turnOf(item('unstarted'))).toBeNull();
    expect(turnOf(triageFailed('failed'))).toBeNull();
    expect(turnOf(ready('done'))).toBeNull();
  });

  it('needsYou leaves out a snoozed work item (PRD R64)', () => {
    expect(needsYou({ ...ready('awaiting-approval'), ticket: { snoozed: false } })).toBe(true);
    expect(needsYou({ ...ready('awaiting-approval'), ticket: { snoozed: true } })).toBe(false);
    expect(needsYou({ ...ready('running', 'running'), ticket: { snoozed: false } })).toBe(false);
    expect(needsYou({ ...triageFailed('failed'), ticket: { snoozed: false } })).toBe(false);
    expect(needsYou({ ...item('failed'), ticket: { snoozed: false } })).toBe(true);
  });
});

describe('holdsSlot', () => {
  it('holds a slot only while the work item runs and its session is not waiting (PRD R38)', () => {
    expect(holdsSlot(item('running', 'running'))).toBe(true);
    expect(holdsSlot(item('setup', 'running'))).toBe(true);
    expect(holdsSlot(item('running', 'waiting'))).toBe(false);
    expect(holdsSlot(opened('running'))).toBe(false);
    expect(['queued', 'awaiting-approval', 'finished', 'blocked', 'failed', 'done'].map((status) => holdsSlot(item(status as WorkItemStatus, 'idle')))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('reviewOrder', () => {
  it("sorts by the operator's position, else readyAt, then by ID (PRD R73)", () => {
    const rows = [
      { id: 1, readyAt: 300, orderAt: null },
      { id: 2, readyAt: 100, orderAt: null },
      { id: 3, readyAt: 500, orderAt: 50 },
      { id: 4, readyAt: 100, orderAt: null },
    ];

    expect(rows.sort(reviewOrder).map((row) => row.id)).toEqual([3, 2, 4, 1]);
  });
});

describe('markOf', () => {
  const marked = (status: WorkItemStatus, states: SessionState[] = [], patch: { approvalSends?: boolean; doneReason?: DoneReason | null; readyAt?: number | null } = {}) =>
    markOf({ ...item(status, ...states), approvalSends: false, doneReason: null, ...patch });

  it('gives what the operator must do in Blocked on you, a question first (PRD R27)', () => {
    expect(marked('awaiting-approval', ['waiting'], { approvalSends: true, readyAt: 1 })).toBe('question');
    expect(marked('running', ['ended', 'waiting'])).toBe('question');
    expect(markOf({ ...opened('running'), approvalSends: false, doneReason: null })).toBe('question');
    expect(markOf({ ...opened('failed'), approvalSends: false, doneReason: null })).toBe('failed');
    expect(marked('blocked')).toBe('blocked');
    expect(marked('failed')).toBe('failed');
    expect(['blocked', 'failed'].map((status) => marked(status as WorkItemStatus, [], { readyAt: 1 }))).toEqual(['blocked', 'failed']);
  });

  it('gives the review to do or the phase in Ready for review (PRD R27)', () => {
    expect(marked('awaiting-approval', [], { readyAt: 1 })).toBe('review');
    expect(marked('awaiting-approval', [], { approvalSends: true, readyAt: 1 })).toBe('send');
    expect(marked('finished', ['idle'], { readyAt: 1 })).toBe('finished');
    expect(marked('running', ['running'], { readyAt: 1 })).toBe('running');
    expect(marked('queued', [], { readyAt: 1 })).toBe('queued');
  });

  it('gives the phase in In progress, Triaging, Failed or none in Unstarted, and how Done ended', () => {
    expect(['setup', 'running'].map((status) => marked(status as WorkItemStatus, ['running']))).toEqual(['setup', 'running']);
    expect(marked('queued')).toBe('queued');
    expect(marked('queued', ['waiting'])).toBe('question');
    expect(marked('triaging')).toBe('triaging');
    expect(markOf({ ...triageFailed('failed'), approvalSends: false, doneReason: null })).toBe('failed');
    expect(marked('unstarted')).toBeNull();
    expect(marked('done', ['waiting'])).toBe('done-session');
    expect(marked('done', [], { doneReason: 'session' })).toBe('done-session');
    expect(marked('done', [], { doneReason: 'operator' })).toBe('done-operator');
    expect(marked('done', [], { doneReason: 'unassigned' })).toBe('done-unassigned');
  });
});

describe('activeSession', () => {
  it('returns the latest session while it has not ended, or null, ignoring an earlier session left open', () => {
    const latest = { state: 'running' as const };
    expect(activeSession({ sessions: [{ state: 'idle' as const }, latest] })).toBe(latest);
    expect(activeSession(item('running', 'ended', 'idle'))).toEqual({ state: 'idle', outcome: null });
    expect(activeSession(item('blocked', 'idle', 'ended'))).toBeNull();
    expect(activeSession(item('unstarted'))).toBeNull();
  });
});

describe('triageLabel', () => {
  it('names the source\'s namespace, or plain triage without one', () => {
    expect(triageLabel('github', { github: 'dev' })).toBe('dev:triage');
    expect(triageLabel('github', { github: '' })).toBe('triage');
    expect(triageLabel('zoho', { github: 'dev' })).toBe('triage');
  });
});

describe('urlKey', () => {
  it('reduces a GitHub issue or pull request page, any tab included, to its owner, repo, kind and number in lower case (PRD R69)', () => {
    expect(urlKey('https://github.com/Acme/Widgets/issues/18941')).toBe('github.com/acme/widgets/issues/18941');
    expect(urlKey('https://GitHub.com/o/r/pull/7/files?w=1#diff')).toBe('github.com/o/r/pull/7');
    expect(urlKey('https://github.com/o/r/issues/7/')).toBe('github.com/o/r/issues/7');
  });

  it('keeps other GitHub pages apart from issues, and pull requests apart from issues', () => {
    expect(urlKey('https://github.com/o/r/issues/7')).not.toBe(urlKey('https://github.com/o/r/pull/7'));
    expect(urlKey('https://github.com/o/r/issues/7x')).toBe('https://github.com/o/r/issues/7x');
    expect(urlKey('https://github.com/o/r/issues')).toBe('https://github.com/o/r/issues');
  });

  it('keeps another URL whole but for a trailing slash, and leaves text that is not a URL as it is', () => {
    expect(urlKey('https://Desk.Example.test/agent/tickets/123/')).toBe('https://desk.example.test/agent/tickets/123');
    expect(urlKey('https://desk.example.test/t?id=5#c')).toBe('https://desk.example.test/t?id=5#c');
    expect(urlKey('not a url/')).toBe('not a url/');
  });
});

describe('adhocLabel', () => {
  it('names an ad-hoc work item by how it was made (PRD R6, R68, R81)', () => {
    const none = { sourceId: null };

    expect(adhocLabel({ parentId: null, prompted: true }, none)).toBe('ad-hoc');
    expect(adhocLabel({ parentId: 4, prompted: true }, none)).toBe('task');
    expect(adhocLabel({ parentId: null, prompted: true }, { sourceId: 'task' })).toBe('task');
    expect(adhocLabel({ parentId: null, prompted: false }, none)).toBe('registered');
  });
});
