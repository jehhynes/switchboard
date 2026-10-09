import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockView, windowOf } from '../src/dock.js';
import type { DockRow } from '../src/dock.js';
import type { WorkItemView } from '../src/runtime.js';
import { item, NOW, pool, session, snapshot, triage } from './views.js';

const worktree = { id: 1, ticketId: 7, path: 'D:/git/widgets/.worktrees/107-fix', branch: '107-fix', linkedBy: 'report' as const };
const row = (entry: WorkItemView): DockRow => dockView(snapshot([entry]), NOW).groups.flatMap((group) => group.rows)[0]!;

describe('dockView', () => {
  // Wake times are local; the recorded message is in UTC.
  const zone = process.env['TZ'];

  beforeAll(() => {
    process.env['TZ'] = 'UTC';
  });
  afterAll(() => {
    if (zone === undefined) {
      delete process.env['TZ'];
    } else {
      process.env['TZ'] = zone;
    }
  });

  it('offers the snooze choices with their wake times', () => {
    expect(dockView(snapshot([]), NOW).snooze.map((choice) => [choice.label, choice.description, choice.until])).toEqual([
      ['Tomorrow', 'Sun, Oct 4, 6:00 AM', Date.UTC(2026, 9, 4, 6)],
      ['In 2 days', 'Mon, Oct 5, 6:00 AM', Date.UTC(2026, 9, 5, 6)],
      ['In 3 days', 'Tue, Oct 6, 6:00 AM', Date.UTC(2026, 9, 6, 6)],
      ['Next week', 'Mon, Oct 5, 6:00 AM', Date.UTC(2026, 9, 5, 6)],
      ['In 2 weeks', 'Mon, Oct 12, 6:00 AM', Date.UTC(2026, 9, 12, 6)],
      ['In 4 weeks', 'Mon, Oct 26, 6:00 AM', Date.UTC(2026, 9, 26, 6)],
      ['Indefinitely', '', null],
    ]);
  });

  it('lists the panel groups in panel order, with Snoozed only when it has rows', () => {
    const view = dockView(snapshot([item(1, { status: 'blocked' }), item(2), item(3, { status: 'unstarted' })], { pool: [pool(4)] }), NOW);

    expect(view.groups.map((group) => [group.key, group.title, group.empty, group.rows.map((entry) => entry.key)])).toEqual([
      ['needs', 'Needs you', 'Nothing needs you.', ['item:1']],
      ['working', 'Working', 'Nothing is running.', ['item:2']],
      ['unstarted', 'Unstarted', 'Nothing waits to be started.', ['item:3', 'ticket:4']],
      ['done', 'Done', null, []],
    ]);
    expect(dockView(snapshot([item(5, { ticket: { ...item(5).ticket, snoozed: true } })]), NOW).groups.at(-1)?.rows.map((entry) => entry.key)).toEqual(['item:5']);
  });

  it('lists configuration errors, then what an unconfigured home lacks', () => {
    expect(dockView(snapshot([], { sources: [], errors: { settings: 'bad JSON', playbooks: [], hooks: null, sources: {} } }), NOW).notes).toEqual([
      'Settings: bad JSON',
      'No source is polled. Turn one on in the title bar.',
    ]);
  });

  it('gives a row the panel texts: title, priority, time, playbook, key, mark and line 3', () => {
    const waiting = row(
      item(7, {
        triage: triage({ immediacy: 'URGENT', severity: 'HIGH' }),
        warning: 'Ticket left the assigned state',
        sessions: [session({ state: 'waiting', stateAt: NOW - 25 * 60_000 })],
        question: { text: 'Which account should I use for the refund?', options: [], parts: 1 },
        parent: { ...item(3).ticket },
        parentId: 3,
      }),
    );

    expect(waiting).toMatchObject({
      key: 'item:7',
      title: 'Issue <7>',
      priority: 'Immediacy: URGENT   Severity: HIGH',
      time: { text: '25m', title: 'Waiting since 2026-10-03 11:35 UTC' },
      playbook: 'dev:develop',
      ticket: 'gh 107',
      source: 'github',
      url: 'https://github.com/o/r/issues/107',
      mark: { kind: 'question', glyph: '\u{eb32}', title: 'Answer a question' },
      stripe: 'warning',
      details: [
        { text: 'Ticket left the assigned state', title: null, tone: 'warning' },
        { text: 'From gh 103', title: 'Issue <3>', tone: null },
        { text: 'Which account should I use for the refund?', title: null, tone: null },
      ],
    });
  });

  it('shows the approval summary with its age, or the stage, coloured when stale', () => {
    expect(row(item(1, { status: 'awaiting-approval', statusAt: NOW - 2 * 3_600_000, approvalSummary: 'post the reply', stage: 'drafting' })).details).toEqual([
      { text: 'Post the reply · 2h', title: 'Post the reply\nLast stage: drafting', tone: null },
    ]);
    expect(row(item(1, { stage: 'fixing tests', stageAt: NOW - 5 * 60_000, sessions: [session()] })).details).toEqual([{ text: 'fixing tests · 5m', title: null, tone: null }]);
    expect(row(item(1, { stage: 'fixing tests', stageAt: NOW - 30 * 60_000, runStartedAt: NOW - 40 * 60_000, sessions: [session({ stateAt: NOW - 40 * 60_000 })] })).details).toEqual([
      { text: 'fixing tests · 30m', title: 'No stage report for 30m', tone: 'warning' },
    ]);
    expect(row(item(1, { runStartedAt: NOW - 40 * 60_000, sessions: [session({ stateAt: NOW - 40 * 60_000 })] })).details).toEqual([
      { text: 'No stage report · 40m', title: 'No stage report for 40m', tone: 'warning' },
    ]);
    expect(row(item(1, { status: 'queued', waits: [{ kind: 'snoozed' }] })).details).toEqual([{ text: 'Starts when the ticket wakes', title: 'The ticket is snoozed.', tone: null }]);
  });

  it('gives a row only the controls the hub runs, with their actions', () => {
    expect(row(item(7, { status: 'awaiting-approval', worktree, pastes: [{ id: 1, workItemId: 7, label: 'Reply', file: 'D:/r.md', reportedAt: NOW }] })).controls).toEqual([
      { label: 'Approve', action: { type: 'approve', workItemId: 7 } },
      { label: 'Triage again', action: { type: 'retriage', workItemId: 7 } },
      { label: 'Mark done', action: { type: 'mark-done', workItemId: 7 } },
      { label: 'Snooze', action: { type: 'snooze', ticketId: 7 } },
    ]);
    expect(row(item(7, { sessions: [session()] })).controls.map((control) => control.label)).toEqual(['Stop', 'Mark done', 'Snooze']);
  });

  it('opens Open in Claude for a waiting background session, the latest session when it is not running, and nothing while it runs', () => {
    expect(row(item(7, { sessions: [session({ state: 'waiting' })] })).open).toEqual({ type: 'question', workItemId: 7, sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets' });
    expect(row(item(7, { status: 'blocked', sessions: [session({ state: 'ended' })] })).open).toEqual({ type: 'session', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets' });
    expect(row(item(7, { sessions: [session({ state: 'idle', released: true })] })).open).toEqual({ type: 'session', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets' });
    expect(row(item(7, { sessions: [session()] })).open).toBeNull();
    expect(row(item(7, { worktree })).open).toBeNull();
    expect(row(item(7, { status: 'unstarted' })).open).toEqual({ type: 'url', url: 'https://github.com/o/r/issues/107' });
    expect(row(item(7, { status: 'unstarted', ticket: { ...item(7).ticket, source: 'adhoc', url: '' } })).open).toBeNull();
  });

  it('gives a pool row its ticket, its triage state and its pool controls, and no window', () => {
    const view = dockView(snapshot([], { pool: [pool(4, { triage: triage({ playbook: null, endedAt: null }) }), pool(5, { triage: triage({ playbook: null, error: 'timed out' }) })] }), NOW);
    const [triaging, failed] = view.groups.find((group) => group.key === 'unstarted')!.rows;

    expect(triaging).toMatchObject({ key: 'ticket:4', playbook: 'dev:triage', mark: { kind: 'triaging', glyph: '\u{eb19}', title: 'Triaging' }, window: null, open: { type: 'url', url: 'https://github.com/o/r/issues/104' }, time: null });
    expect(triaging!.controls).toEqual([{ label: 'Snooze', action: { type: 'snooze', ticketId: 4 } }]);
    expect(failed!.details).toEqual([{ text: 'timed out', title: null, tone: 'warning' }]);
    expect(failed!.controls.map((control) => control.action)).toEqual([{ type: 'retriage-pool', ticketId: 5 }, { type: 'snooze', ticketId: 5 }]);
  });

  it('matches the recorded dock message the dock app reads', () => {
    const recorded = JSON.parse(readFileSync(new URL('../../../apps/dock/test/fixtures/dock.json', import.meta.url), 'utf8')) as unknown;
    const view = dockView(
      snapshot(
        [
          item(7, { status: 'blocked', error: 'The session finished its turn.', worktree, sessions: [session({ state: 'ended', cwd: worktree.path })] }),
          item(8, { sessions: [session({ state: 'waiting', cwd: 'D:/git/widgets' })], question: { text: 'Which branch?', options: [], parts: 1 } }),
          item(9, { status: 'unstarted', triage: triage({ immediacy: 'BLOCKING', severity: 'MED' }) }),
        ],
        { pool: [pool(4)] },
      ),
      NOW,
    );

    expect(view).toEqual(recorded);
  });
});

describe('windowOf', () => {
  it('opens the latest session folder first, with the worktree second when the session ran elsewhere', () => {
    expect(windowOf(item(7, { worktree, sessions: [session({ cwd: 'D:\\git\\widgets\\.worktrees\\107-fix\\' })] }))).toEqual({
      name: 'gh-107-58c609',
      title: 'sb:gh-107-58c609 · Issue <7>',
      folders: ['D:\\git\\widgets\\.worktrees\\107-fix\\'],
    });
    expect(windowOf(item(7, { worktree, sessions: [session({ cwd: 'D:/git/widgets' })] }))).toEqual({
      name: 'gh-107-widgets-655280',
      title: 'sb:gh-107-widgets-655280 · Issue <7>',
      folders: ['D:/git/widgets', 'D:/git/widgets/.worktrees/107-fix'],
    });
    expect(windowOf(item(7, { worktree }))).toEqual({ name: 'gh-107-58c609', title: 'sb:gh-107-58c609 · Issue <7>', folders: ['D:/git/widgets/.worktrees/107-fix'] });
    expect(windowOf(item(7, { sessions: [session({ cwd: 'D:/git/support' })], ticket: { ...item(7).ticket, source: 'zoho', sourceKey: '4521/a b' } }))).toEqual({
      name: 'zoho-4521-a-b-support-c6262c',
      title: 'sb:zoho-4521-a-b-support-c6262c · Issue <7>',
      folders: ['D:/git/support'],
    });
    expect(windowOf(item(7))).toBeNull();
  });

  it('gives each first folder its own name, so a window never changes its first folder', () => {
    const names = ['D:/one/review', 'D:/two/review'].map((cwd) => windowOf(item(7, { sessions: [session({ cwd })] }))!.name);
    const moved = windowOf(item(7, { worktree: { ...worktree, path: 'E:/wt/107-fix' } }))!.name;

    expect(names[0]).toMatch(/^gh-107-review-[0-9a-f]{6}$/);
    expect(names[1]).toMatch(/^gh-107-review-[0-9a-f]{6}$/);
    expect(names[0]).not.toBe(names[1]);
    expect(moved).toMatch(/^gh-107-[0-9a-f]{6}$/);
    expect(moved).not.toBe('gh-107-58c609');
  });
});
