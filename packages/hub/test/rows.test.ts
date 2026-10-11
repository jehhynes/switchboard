import { describe, expect, it } from 'vitest';
import { groupOf } from '@switchboard/core/group';
import {
  clockOf,
  controlsOf,
  listGroups,
  moveControls,
  doneBand,
  doneStamp,
  mainControl,
  poolControls,
  priorityTitle,
  queueTime,
  rankOf,
  rowTime,
  setupNotes,
  snapshotErrors,
  stripeOf,
  waitTexts,
} from '../src/rows.js';
import type { WorkItemView } from '../src/runtime.js';
import { item, NOW, pool, session, snapshot, triage } from './views.js';

const labels = (entry: WorkItemView) => controlsOf(entry).map((control) => control.label);

describe('groupOf', () => {
  it('puts done first, then unstarted, triaging and queued work, then work blocked on the operator, then ready work, then the rest', () => {
    expect(groupOf(item(1, { status: 'done', sessions: [session({ state: 'waiting' })] }))).toBe('done');
    expect(['unstarted', 'triaging', 'queued'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['unstarted', 'unstarted', 'unstarted']);
    expect(['blocked', 'failed'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'], readyAt: NOW })))).toEqual(['blocked', 'blocked']);
    expect(groupOf(item(1, { sessions: [session({ state: 'waiting' })] }))).toBe('blocked');
    expect(['awaiting-approval', 'finished'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['review', 'review']);
    expect(groupOf(item(1, { readyAt: NOW, sessions: [session()] }))).toBe('review');
    expect(['setup', 'running'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['progress', 'progress']);
  });
});

describe('controlsOf', () => {
  it('shows only the controls that apply, with no session controls and no Change playbook', () => {
    expect(labels(item(1, { status: 'unstarted' }))).toEqual(['Start', 'Triage again', 'Mark done', 'Snooze', 'Delete', 'History']);
    expect(labels(item(1, { status: 'awaiting-approval' }))).toEqual(['Approve', 'Triage again', 'Mark done', 'Snooze', 'Delete', 'History']);
    expect(labels(item(1, { sessions: [session()] }))).toEqual(['Stop', 'Mark done', 'Snooze', 'Open in terminal', 'Delete', 'History']);
    expect(labels(item(1, { sessions: [session({ state: 'starting', shortId: null })] }))).toEqual(['Mark done', 'Snooze', 'History']);
    expect(labels(item(1, { status: 'blocked', sessions: [session({ state: 'ended' })] }))).toEqual(['Triage again', 'Mark done', 'Snooze', 'Open in terminal', 'Delete', 'History']);
    expect(labels(item(1, { status: 'triaging' }))).toEqual(['Mark done', 'Snooze', 'Delete', 'History']);
    expect(labels(item(1, { status: 'done', sessions: [session({ state: 'ended' })] }))).toEqual(['Open in terminal', 'Delete', 'History']);
    expect(labels(item(1, { status: 'failed', ticket: { ...item(1).ticket, source: 'adhoc' } }))).toEqual(['Mark done', 'Snooze', 'Delete', 'History']);
    expect(labels(item(1, { status: 'blocked', sessions: [session({ released: true })] }))).toEqual(['Mark done', 'Snooze', 'Open in terminal', 'Delete', 'History']);
    expect(controlsOf(item(7, { sessions: [session()] })).map((control) => control.message)).toEqual([
      { type: 'action', action: { type: 'stop', workItemId: 7 } },
      { type: 'action', action: { type: 'mark-done', workItemId: 7 } },
      { type: 'action', action: { type: 'snooze', ticketId: 7 } },
      { type: 'terminal', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', name: 'gh 107', shortId: 'aaaa1111', active: false },
      { type: 'action', action: { type: 'delete', workItemId: 7 } },
      { type: 'history', ticketId: 7, key: 'gh 107' },
    ]);
  });

  it('asks before Delete, naming the session it stops, and offers no Delete while a session starts (PRD R76)', () => {
    const confirm = (entry: WorkItemView) => controlsOf(entry).find((control) => control.label === 'Delete')?.confirm ?? null;
    const kept = "Switchboard deletes the work item, its sessions and its history. The ticket, its worktree and Claude's session files stay.";
    const returns = 'The ticket gets a new work item only when it is assigned to you again.';

    expect(confirm(item(7, { sessions: [session()] }))).toEqual({ question: 'Delete gh 107?', detail: `Its running session is stopped. ${kept} ${returns}`, action: 'Delete' });
    expect(confirm(item(7, { sessions: [session({ state: 'idle', released: true })] }))?.detail).toBe(`${kept} ${returns}`);
    expect(confirm(item(7, { status: 'done', sessions: [session({ state: 'ended' })] }))?.detail).toBe(`${kept} ${returns}`);
    expect(confirm(item(7, { status: 'failed', ticket: { ...item(7).ticket, source: 'adhoc' } }))?.detail).toBe(kept);
    expect(confirm(item(7, { sessions: [session({ state: 'starting', shortId: null })] }))).toBeNull();
  });

  it('attaches a terminal to a background session, resumes the latest ended session, shows one the operator resumed, and offers none while a session starts (PRD R28)', () => {
    const terminal = (entry: WorkItemView) => controlsOf(entry).find((control) => control.label === 'Open in terminal')?.message ?? null;
    const waiting = item(7, { sessions: [session({ state: 'waiting' })] });

    expect(terminal(waiting)).toEqual({ type: 'terminal', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', name: 'gh 107', shortId: 'aaaa1111', active: false });
    expect(labels(waiting)).toContain('Open in Claude');
    expect(terminal(item(7, { sessions: [session({ nativeSessionId: null })] }))).toMatchObject({ sessionId: 'aaaa1111', shortId: 'aaaa1111' });
    expect(terminal(item(7, { sessions: [session({ id: 's0', nativeSessionId: 'old-native', state: 'ended' }), session({ state: 'ended', cwd: 'D:/wt' })] }))).toEqual({ type: 'terminal', sessionId: 'aaaa1111-native', cwd: 'D:/wt', name: 'gh 107', shortId: null, active: false });
    // Released and not ended: the roster lists it as interactive, as for a terminal or a VS Code tab.
    expect(terminal(item(7, { sessions: [session({ state: 'idle', released: true })] }))).toEqual({ type: 'terminal', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', name: 'gh 107', shortId: null, active: true });
    expect(terminal(item(7, { sessions: [session({ state: 'starting', shortId: null })] }))).toBeNull();
    expect(terminal(item(7, { sessions: [session({ state: 'ended', nativeSessionId: null })] }))).toBeNull();
    expect(terminal(item(7))).toBeNull();
  });
});

describe('mainControl', () => {
  it('picks the one primary control of a Blocked on you, Ready for review or Unstarted row', () => {

    expect(mainControl(item(1, { status: 'awaiting-approval' }))?.label).toBe('Approve');
    expect(mainControl(item(1, { status: 'failed' }))?.label).toBe('Triage again');
    expect(mainControl(item(1, { status: 'failed', ticket: { ...item(1).ticket, source: 'adhoc' } }))).toBeNull();
    expect(mainControl(item(1, { status: 'blocked', sessions: [session({ state: 'ended' })] }))).toBeNull();
    expect(mainControl(item(1, { status: 'unstarted' }))?.label).toBe('Start');
    expect(mainControl(item(1, { status: 'triaging' }))).toBeNull();
    expect(mainControl(item(1, { sessions: [session({ state: 'waiting', released: true })] }))).toBeNull();
    expect(mainControl(item(1))).toBeNull();
  });
});

describe('clockOf', () => {
  it('counts Blocked on you from the status or the wait, Ready for review from readyAt, In progress from the run start, and the rest from scope entry, stopping at done (PRD R27)', () => {
    const scoped = (patch: Partial<WorkItemView>, scopeAt: number | null = 5, snoozed = false) =>
      item(1, { createdAt: 1, statusAt: 2, runStartedAt: 3, ...patch, ticket: { ...item(1).ticket, scopeAt, snoozed } });

    expect(clockOf(scoped({ status: 'blocked' }))).toEqual({ since: 2, label: 'In this status since' });
    expect(clockOf(scoped({ status: 'running', sessions: [session({ state: 'waiting', stateAt: 4 })] }))).toEqual({ since: 4, label: 'Waiting since' });
    expect(clockOf(scoped({ status: 'setup', sessions: [session({ kind: 'setup', state: 'waiting', stateAt: 4 })] }))).toEqual({ since: 4, label: 'Waiting since' });
    // A blocked item whose session still waits counts from the block.
    expect(clockOf(scoped({ status: 'blocked', sessions: [session({ state: 'waiting', stateAt: 4 })] }))).toEqual({ since: 2, label: 'In this status since' });
    expect(clockOf(scoped({ status: 'awaiting-approval', readyAt: 6, sessions: [session({ state: 'waiting', stateAt: 4 })] }))).toEqual({ since: 4, label: 'Waiting since' });
    expect(clockOf(scoped({ status: 'awaiting-approval', readyAt: 6 }))).toEqual({ since: 6, label: 'Ready since' });
    expect(clockOf(scoped({ status: 'running', readyAt: 6 }))).toEqual({ since: 6, label: 'Ready since' });
    expect(clockOf(scoped({ status: 'running' }))).toEqual({ since: 3, label: 'Working since' });
    expect(clockOf(scoped({ status: 'setup', runStartedAt: null }))).toEqual({ since: 2, label: 'Working since' });
    expect(clockOf(scoped({ status: 'queued' }))).toEqual({ since: 5, label: 'In scope since' });
    expect(clockOf(scoped({ status: 'unstarted' }))).toEqual({ since: 5, label: 'In scope since' });
    expect(clockOf(scoped({ status: 'unstarted' }, null))).toEqual({ since: 1, label: 'In scope since' });
    expect(clockOf(scoped({ status: 'blocked' }, 5, true))).toEqual({ since: 5, label: 'In scope since' });
    // Done keeps the scope entry the work item had, not the ticket's later one.
    expect(clockOf(scoped({ status: 'done', doneAt: 9, scopeAt: 4 }, 8))).toEqual({ since: 4, label: 'In scope from' });
    expect(clockOf(scoped({ status: 'done', doneAt: 9 }, 8))).toEqual({ since: 1, label: 'In scope from' });
  });
});

describe('doneStamp and doneBand', () => {
  // Wednesday 7 October 2026, 10:00 local time; the week began on Monday 5 October.
  const now = new Date(2026, 9, 7, 10).getTime();
  const at = (day: number, hour = 0) => new Date(2026, 9, day, hour).getTime();

  it('bands by local day, with weeks starting on Monday', () => {
    const times = [at(7), at(6, 23), at(6), at(5), at(4, 23), new Date(2026, 8, 28).getTime(), new Date(2026, 8, 27, 23).getTime()];

    expect(times.map((time) => doneBand(time, now))).toEqual(['Today', 'Yesterday', 'Yesterday', 'Earlier this week', 'Last week', 'Last week', 'Older']);
  });

  it('puts Monday’s yesterday in Yesterday, not Last week', () => {
    expect(doneBand(at(4, 12), at(5, 9))).toBe('Yesterday');
    expect(doneBand(at(3, 12), at(5, 9))).toBe('Last week');
  });

  it('stamps a done time as 24-hour HH:mm today and m/d before today, in local time', () => {
    expect([at(7, 9), at(7, 13) + 5 * 60_000, at(7, 0), at(6, 23), new Date(2026, 8, 28).getTime()].map((time) => doneStamp(time, now))).toEqual(['09:00', '13:05', '00:00', '10/6', '9/28']);
  });

});

describe('rankOf and queueTime', () => {
  it('ranks only a full rating', () => {
    expect(rankOf(triage({ immediacy: 'URGENT', severity: 'HIGH' }))).toBe(0);
    expect(rankOf(triage({ immediacy: 'NON-BLOCKING', severity: 'LOW' }))).toBe(4);
    expect(rankOf(triage({ immediacy: 'BLOCKING' }))).toBeNull();
    expect(rankOf(null)).toBeNull();
  });

  it('gives whole minutes, hours, days and weeks', () => {
    expect([59_000, 59 * 60_000, 60 * 60_000, 23 * 3_600_000 + 59 * 60_000, 86_400_000, 6 * 86_400_000, 7 * 86_400_000, 20 * 86_400_000, -5_000].map((ms) => queueTime(NOW - ms, NOW))).toEqual([
      '0m',
      '59m',
      '1h',
      '23h',
      '1d',
      '6d',
      '1w',
      '2w',
      '0m',
    ]);
  });
});

describe('poolControls', () => {
  it('offers Start once triage chose a playbook, Triage again after a failed triage, and neither while it runs', () => {
    const labels = (entry: ReturnType<typeof pool>) => {
      const { main, controls } = poolControls(entry);

      return [main?.label ?? null, controls.map((control) => control.label)];
    };

    expect(labels(pool(3))).toEqual(['Start', ['Start', 'Snooze', 'History']]);
    expect(labels(pool(3, { triage: triage({ playbook: null, error: 'timed out' }) }))).toEqual(['Triage again', ['Triage again', 'Snooze', 'History']]);
    expect(labels(pool(3, { triage: triage({ playbook: null, endedAt: null }) }))).toEqual([null, ['Snooze', 'History']]);
    expect(labels(pool(3, { ticket: { ...pool(3).ticket, snoozed: true } }))).toEqual(['Start', ['Start', 'Snooze', 'Restore', 'History']]);
    expect(poolControls(pool(3)).main?.message).toEqual({ type: 'action', action: { type: 'pick', ticketId: 3 } });
  });
});

describe('stripeOf', () => {
  it("stripes failed rows red, blocked or waiting rows yellow and the operator's turn, but not the agent's turn, Snoozed or the other groups (PRD R27)", () => {
    expect(stripeOf(item(1, { status: 'failed' }))).toBe('error');
    expect(stripeOf(item(1, { status: 'blocked' }))).toBe('warning');
    expect(stripeOf(item(1, { sessions: [session({ state: 'waiting' })] }))).toBe('warning');
    expect(stripeOf(item(1, { status: 'awaiting-approval' }))).toBe('turn');
    expect(stripeOf(item(1, { status: 'finished' }))).toBe('turn');
    expect(stripeOf(item(1, { status: 'running', readyAt: NOW, sessions: [session()] }))).toBeNull();
    expect(stripeOf(item(1, { status: 'running', sessions: [session()] }))).toBeNull();
    expect(stripeOf(item(1, { status: 'unstarted' }))).toBeNull();
    expect(stripeOf(item(1, { status: 'done' }))).toBeNull();
    expect(stripeOf(item(1, { status: 'failed', ticket: { ...item(1).ticket, snoozed: true } }))).toBeNull();
  });
});

describe('listGroups', () => {
  it("orders Blocked on you by wait, Ready for review by the operator's place or readyAt, and In progress by run start (PRD R27)", () => {
    const groups = listGroups(
      snapshot([
        item(1, { status: 'awaiting-approval', readyAt: NOW - 3000 }),
        item(2, { status: 'running', readyAt: NOW - 5000, sessions: [session()] }),
        item(3, { status: 'finished', readyAt: NOW - 1000, orderAt: NOW - 9000 }),
        item(4, { status: 'blocked', statusAt: NOW - 100 }),
        item(5, { status: 'failed', statusAt: NOW - 200 }),
        item(6, { status: 'running', runStartedAt: NOW - 10, sessions: [session()] }),
        item(7, { status: 'setup', runStartedAt: NOW - 20, sessions: [session()] }),
      ]),
    );
    const ids = (rows: unknown[]) => rows.map((row) => (row as WorkItemView).id);

    expect([ids(groups.blocked), ids(groups.review), ids(groups.progress)]).toEqual([
      [5, 4],
      [3, 2, 1],
      [7, 6],
    ]);
  });

  it('keeps a Ready for review row in its place while its turn changes', () => {
    const rows = (first: Partial<WorkItemView>) =>
      listGroups(snapshot([item(1, { readyAt: NOW - 3000, ...first }), item(2, { status: 'awaiting-approval', readyAt: NOW - 2000 }), item(3, { status: 'finished', readyAt: NOW - 1000 })])).review.map(
        (row) => (row as WorkItemView).id,
      );

    expect(rows({ status: 'awaiting-approval', statusAt: NOW })).toEqual([1, 2, 3]);
    expect(rows({ status: 'running', statusAt: NOW, sessions: [session()] })).toEqual([1, 2, 3]);
    expect(rows({ status: 'queued', statusAt: NOW })).toEqual([1, 2, 3]);
  });
});

describe('moveControls', () => {
  it("offers Move to top, Move up and Move down from the row's neighbours, and Reset position once moved (PRD R73)", () => {
    const moves = (id: number, orderAt: number | null = null) =>
      moveControls(item(id, { status: 'awaiting-approval', orderAt }), [4, 7, 9]).map((control) => [control.label, control.message['action']]);

    expect(moves(4)).toEqual([['Move down', { type: 'move', workItemId: 4, after: 7 }]]);
    expect(moves(7)).toEqual([
      ['Move to top', { type: 'move', workItemId: 7, after: null }],
      ['Move up', { type: 'move', workItemId: 7, after: null }],
      ['Move down', { type: 'move', workItemId: 7, after: 9 }],
    ]);
    expect(moves(9, NOW)).toEqual([
      ['Move to top', { type: 'move', workItemId: 9, after: null }],
      ['Move up', { type: 'move', workItemId: 9, after: 4 }],
      ['Reset position', { type: 'reset-position', workItemId: 9 }],
    ]);
    expect(moves(5)).toEqual([]);
  });
});

describe('waitTexts', () => {
  it('words each reason a queued row waits, with what ends it', () => {
    expect(
      waitTexts(
        item(1, {
          status: 'queued',
          waits: [
            { kind: 'slot', used: 2, limit: 2 },
            { kind: 'session', sessionId: 's2', shortId: null, ownItem: false, playbook: null },
            { kind: 'snoozed' },
          ],
        }),
      ),
    ).toEqual([
      { text: 'Waits for a slot · 2/2 in use', title: '2 sessions are running; sessions.concurrency is 2.' },
      { text: "Waits for the ad-hoc session's turn to end", title: 'Session s2 on this ticket is running or waiting on a question. This starts when its turn ends.' },
      { text: 'Starts when the ticket wakes', title: 'The ticket is snoozed.' },
    ]);
  });
});

describe('rowTime', () => {
  it('shows the time in queue, or the done time on an unsnoozed Done row', () => {
    expect(rowTime(item(1, { status: 'blocked', statusAt: NOW - 3 * 3_600_000 }), NOW)).toEqual({ text: '3h', title: 'In this status since 2026-10-03 09:00 UTC' });
    expect(rowTime(item(1, { status: 'done', doneAt: NOW - 2 * 86_400_000, scopeAt: NOW - 5 * 86_400_000 }), NOW)).toEqual({
      text: `${new Date(NOW - 2 * 86_400_000).getMonth() + 1}/${new Date(NOW - 2 * 86_400_000).getDate()}`,
      title: 'Done 2026-10-01 12:00 UTC; in scope from 2026-09-28 12:00 UTC',
    });
  });
});

describe('priorityTitle', () => {
  it('names the rating of a priority ticket only', () => {
    expect(priorityTitle(triage({ immediacy: 'BLOCKING', severity: null }))).toBe('Immediacy: BLOCKING   Severity: ?');
    expect(priorityTitle(triage({ immediacy: 'NON-BLOCKING', severity: 'LOW' }))).toBeNull();
    expect(priorityTitle(null)).toBeNull();
  });
});

describe('snapshotErrors and setupNotes', () => {
  it('lists every configuration error, and what an unconfigured home lacks', () => {
    expect(snapshotErrors(snapshot([], { errors: { settings: 'bad JSON', playbooks: ['dev/x.md: no description'], hooks: 'malformed', sources: { zoho: 'no token' } } }))).toEqual([
      'Settings: bad JSON',
      'Playbook dev/x.md: no description',
      'Hooks: malformed',
      'zoho: no token',
    ]);
    expect(snapshotErrors(snapshot([]))).toEqual([]);
    expect(setupNotes(snapshot([]))).toEqual([]);
    expect(setupNotes(snapshot([], { sources: [], playbooks: [] }))).toEqual([
      'No source is polled. Turn one on in the header.',
      'No task playbooks are loaded. Add them under playbooks in C:\\Users\\me\\.claude\\switchboard\\settings.json.',
    ]);
    expect(setupNotes(snapshot([], { sources: [], sourceStates: [] }))).toEqual(['No source is configured. Add one in C:\\Users\\me\\.claude\\switchboard\\settings.json.']);
  });
});
