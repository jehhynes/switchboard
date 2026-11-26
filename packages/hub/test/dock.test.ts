import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MESSAGES, PERMISSION_PROMPT, QUESTION_CARD } from '@switchboard/core';
import { wakeText } from '@switchboard/core/snooze';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockView, sourceGroups, windowOf, windowsDir, workspaceText, writeWorkspaceFile } from '../src/dock.js';
import type { DockRow } from '../src/dock.js';
import { CONTROL_GLYPHS } from '../src/rows.js';
import type { HeldSession } from '../src/held.js';
import type { Snapshot, WorkItemView } from '../src/runtime.js';
import { item, NOW, pool, session, snapshot, triage, workState } from './views.js';

/** Where the tests' item windows keep their workspace files. */
const W = 'C:\\Users\\op\\.switchboard\\windows';
const worktree = { id: 1, ticketId: 7, path: 'D:/git/widgets/.worktrees/107-fix', branch: '107-fix', linkedBy: 'report' as const };
const row = (entry: WorkItemView): DockRow => dockView(snapshot([entry]), NOW, W).groups.flatMap((group) => group.rows)[0]!;

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
    expect(dockView(snapshot([]), NOW, W).snooze.map((choice) => [choice.label, choice.description, choice.until])).toEqual([
      ['Tomorrow', 'Sun, Oct 4, 6:00 AM', Date.UTC(2026, 9, 4, 6)],
      ['In 2 days', 'Mon, Oct 5, 6:00 AM', Date.UTC(2026, 9, 5, 6)],
      ['In 3 days', 'Tue, Oct 6, 6:00 AM', Date.UTC(2026, 9, 6, 6)],
      ['In 2 weeks', 'Sat, Oct 17, 6:00 AM', Date.UTC(2026, 9, 17, 6)],
      ['In 4 weeks', 'Sat, Oct 31, 6:00 AM', Date.UTC(2026, 9, 31, 6)],
      ['Indefinitely', '', null],
    ]);
  });

  it("leaves out the held sessions and their note when the holder holds none (PRD R94)", () => {
    expect('held' in dockView(snapshot([]), NOW, W)).toBe(false);
    expect('heldNote' in dockView(snapshot([]), NOW, W)).toBe(false);
  });

  it('lists the groups in order, with Snoozed before Done and only when it has rows', () => {
    const view = dockView(snapshot([item(1, { status: 'blocked' }), item(2), item(3, { status: 'unstarted' })], { pool: [pool(4)] }), NOW, W);

    expect(view.groups.map((group) => [group.key, group.title, group.empty, group.rows.map((entry) => entry.key)])).toEqual([
      ['review', 'Ready for review', 'Nothing to review. Finished work appears here for you to check.', []],
      ['blocked', 'Blocked on you', null, ['item:1']],
      ['progress', 'In progress', 'Nothing in progress. Work appears here while its session runs.', ['item:2']],
      ['unstarted', 'Unstarted', 'Nothing to start. New work items wait here until their session starts.', ['item:3', 'ticket:4']],
      ['done', 'Done', null, []],
    ]);
    // Blocked on you is left out when empty, as Snoozed is.
    expect(dockView(snapshot([item(5, { ticket: { ...item(5).ticket, snoozed: true } })]), NOW, W).groups.map((group) => [group.key, group.rows.map((entry) => entry.key)])).toEqual([
      ['review', []],
      ['progress', []],
      ['unstarted', []],
      ['snoozed', ['item:5']],
      ['done', []],
    ]);
  });

  it("gives each row its turn, dimming and Move controls (PRD R27, R73)", () => {
    const view = dockView(
      snapshot([
        item(1, { status: 'awaiting-approval', readyAt: NOW - 3000 }),
        item(2, { status: 'running', readyAt: NOW - 2000, sessions: [session()] }),
        item(3, { status: 'finished', readyAt: NOW - 1000 }),
        item(4, { status: 'running', sessions: [session()] }),
        item(5, { status: 'blocked' }),
        item(6, { status: 'awaiting-approval', ticket: { ...item(6).ticket, snoozed: true } }),
      ]),
      NOW,
      W,
    );
    const shown = view.groups.map((group) => [group.key, group.rows.map((entry) => [entry.key, entry.turn, entry.dim, entry.movable, entry.stripe])]);

    expect(shown).toEqual([
      [
        'review',
        [
          ['item:1', 'operator', false, true, 'turn'],
          ['item:2', 'agent', true, true, null],
          ['item:3', 'operator', false, true, 'turn'],
        ],
      ],
      ['blocked', [['item:5', 'operator', false, false, 'warning']]],
      ['progress', [['item:4', 'agent', false, false, null]]],
      ['unstarted', []],
      ['snoozed', [['item:6', null, false, false, null]]],
      ['done', []],
    ]);

    const second = view.groups.find((group) => group.key === 'review')!.rows[1]!;
    expect(second.controls.filter((control) => control.action['type'] === 'move')).toEqual([
      { label: 'Move to top', glyph: '\u{ebff}', action: { type: 'move', workItemId: 2, after: null } },
      { label: 'Move up', glyph: '\u{eaa1}', action: { type: 'move', workItemId: 2, after: null } },
      { label: 'Move down', glyph: '\u{ea9a}', action: { type: 'move', workItemId: 2, after: 3 } },
    ]);
    expect(view.groups.find((group) => group.key === 'progress')!.rows[0]!.controls.some((control) => control.action['type'] === 'move')).toBe(false);
  });

  it('lists configuration errors, then what an unconfigured home lacks', () => {
    expect(dockView(snapshot([], { sources: [], errors: { settings: 'bad JSON', playbooks: [], hooks: null, sources: {} } }), NOW, W).notes).toEqual([
      'Settings: bad JSON',
      'No source is on. Turn one on in the list header.',
    ]);
  });

  it('gives a row the panel texts: title, priority, time, playbook, key, mark and line 3', () => {
    const waiting = row(
      item(7, {
        triage: triage({ immediacy: 'URGENT', severity: 'HIGH' }),
        warning: 'Ticket left the assigned state',
        sessions: [session({ state: 'waiting', stateAt: NOW - 25 * 60_000 })],
        state: workState('checking refunds', NOW - 30 * 60_000),
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
      ],
    });
    // The question is answered in Claude, so line 3 names the mark in place of the state.
    expect(row(item(7, { sessions: [session({ state: 'waiting' })], state: workState('checking refunds', NOW - 60_000) })).details).toEqual([{ text: 'Answer a question', title: null, tone: null }]);
  });

  it('marks a permission prompt, says what answers it on line 3 without the state, and opens a terminal from its main control (PRD R70)', () => {
    const permission = row(item(7, { status: 'running', sessions: [session({ codeMode: true, withoutCodeMode: true, state: 'waiting', stateDetail: PERMISSION_PROMPT })], state: workState('checking refunds', NOW - 60_000) }));

    expect(permission).toMatchObject({
      mark: { kind: 'permission', glyph: '\u{eb53}', title: 'Approve a permission' },
      stripe: 'warning',
      main: 'Open in terminal',
      details: [{ text: 'Waits for your permission in its terminal', title: 'Claude asks to approve a tool call. Open in terminal to answer it; stopping the session would drop the prompt.', tone: null }],
    });
    expect(permission.open).toEqual({ type: 'session', sessionId: 's1', cwd: 'D:/git/widgets', provider: 'claude' });
  });

  it('marks a held turn that ended on an unanswered question card Answer a question in Blocked on you, without the state or a main control (PRD R103)', () => {
    const card = row(item(7, { status: 'running', sessions: [session({ state: 'idle', stateDetail: QUESTION_CARD, codeMode: true })], state: workState('checking refunds', NOW - 60_000) }));

    expect(card).toMatchObject({ mark: { kind: 'question', title: 'Answer a question' }, stripe: 'warning', details: [{ text: 'Answer a question', title: null, tone: null }] });
    expect(card.main).toBeNull();
    expect(dockView(snapshot([item(7, { status: 'running', sessions: [session({ state: 'idle', stateDetail: QUESTION_CARD, codeMode: true })] })]), NOW, W).groups.find((group) => group.rows.length > 0)?.key).toBe('blocked');
  });

  it('says why an unstarted work item waits when nothing is newer than the earlier work item (PRD R80)', () => {
    expect(row(item(1, { status: 'unstarted', error: MESSAGES.nothingNew })).details).toEqual([{ text: 'Nothing new since the earlier work item', title: null, tone: 'warning' }]);
  });

  it('names the open blockers on line 3 of an open work item or pool row, as a wait reason once queued, and not once done (PRD R90)', () => {
    const one = [{ url: 'https://github.com/o/r/issues/12', ref: '#12', title: 'Migrate the schema' }];
    const three = [...one, { url: 'https://github.com/o/r/issues/15', ref: '#15', title: 'Add the API' }, { url: 'https://github.com/o/docs/issues/7', ref: 'o/docs#7', title: 'Docs' }];
    const blocked = (blockers: typeof one) => ({ ...item(1).ticket, blockers });

    expect(row(item(1, { status: 'unstarted', ticket: blocked(one) })).details).toEqual([
      { text: 'Blocker: #12', title: 'Open issues that block this one:\n#12 Migrate the schema\nA start waits until it closes.', tone: 'warning' },
    ]);
    expect(row(item(1, { ticket: blocked(three), sessions: [session()], state: workState('planning', NOW - 60_000) })).details).toEqual([
      { text: 'Blockers: #12, #15 and o/docs#7', title: 'Open issues that block this one:\n#12 Migrate the schema\n#15 Add the API\no/docs#7 Docs\nA start waits until they close.', tone: 'warning' },
      { text: 'planning · 1m', title: null, tone: null },
    ]);
    expect(row(item(1, { status: 'queued', ticket: blocked(three.slice(0, 2)), waits: [{ kind: 'blockers', blockers: three.slice(0, 2) }] })).details).toEqual([
      { text: 'Starts when #12 and #15 close', title: 'Open issues that block this one:\n#12 Migrate the schema\n#15 Add the API', tone: null },
    ]);
    expect(row(item(1, { status: 'done', doneAt: NOW, ticket: blocked(one) })).details).toEqual([{ text: 'Finished by the session', title: null, tone: null }]);

    // An older hub's snapshot has no blockers.
    const { blockers: _omitted, ...older } = item(1).ticket;
    expect(row(item(1, { status: 'unstarted', ticket: older })).details).toEqual([]);

    const pooled = dockView(snapshot([], { pool: [pool(4, { ticket: { ...pool(4).ticket, blockers: one } })] }), NOW, W).groups.flatMap((group) => group.rows);
    expect(pooled.map((entry) => entry.details)).toEqual([[{ text: 'Blocker: #12', title: 'Open issues that block this one:\n#12 Migrate the schema\nA start waits until it closes.', tone: 'warning' }]]);
  });

  it('shows the approval summary with its age, or the stage, coloured when stale', () => {
    expect(row(item(1, { status: 'awaiting-approval', statusAt: NOW - 2 * 3_600_000, approvalSummary: 'post the reply', state: workState('drafting', NOW) })).details).toEqual([
      { text: 'Post the reply · 2h', title: 'Post the reply\nLast state: drafting', tone: null },
    ]);
    expect(row(item(1, { state: workState('fixing tests', NOW - 5 * 60_000), sessions: [session()] })).details).toEqual([{ text: 'fixing tests · 5m', title: null, tone: null }]);
    expect(row(item(1, { state: workState('fixing tests', NOW - 29 * 60_000), runStartedAt: NOW - 40 * 60_000, sessions: [session({ stateAt: NOW - 40 * 60_000 })] })).details).toEqual([{ text: 'fixing tests · 29m', title: null, tone: null }]);
    expect(row(item(1, { state: workState('fixing tests', NOW - 30 * 60_000), runStartedAt: NOW - 40 * 60_000, sessions: [session({ stateAt: NOW - 40 * 60_000 })] })).details).toEqual([
      { text: 'fixing tests · 30m', title: 'No state for 30m', tone: 'warning' },
    ]);
    expect(row(item(1, { runStartedAt: NOW - 40 * 60_000, sessions: [session({ stateAt: NOW - 40 * 60_000 })] })).details).toEqual([
      { text: 'No state · 40m', title: 'No state for 40m', tone: 'warning' },
    ]);
    expect(row(item(1, { status: 'queued', waits: [{ kind: 'snoozed' }] })).details).toEqual([{ text: 'Starts after the snooze ends', title: 'The ticket is snoozed.', tone: null }]);
  });

  it("dims a state whose turn ended and names one whose session ended the last state, so neither reads as current", () => {
    const long = 'a headline that runs past the forty characters of the row';

    expect(row(item(1, { state: workState('fixing tests', NOW - 60_000, { turnEnded: true }), sessions: [session()] })).details).toEqual([
      { text: 'fixing tests · 1m', title: 'fixing tests\nAs of the last turn', tone: 'dim' },
    ]);
    // A session between turns makes its state old even before the turn end reaches the state.
    expect(row(item(1, { status: 'finished', state: workState('ready for review', NOW - 60_000), sessions: [session({ state: 'idle' })] })).details).toContainEqual({ text: 'ready for review · 1m', title: 'ready for review\nAs of the last turn', tone: 'dim' });
    expect(row(item(1, { status: 'finished', state: workState('done', NOW - 60_000), sessions: [session({ state: 'ended' })] })).details).toContainEqual({ text: 'Last state: done · 1m', title: 'Last state: done', tone: 'dim' });
    // A stage carried over from before states has no session; a state of a session that is gone is old too.
    expect(row(item(1, { status: 'finished', state: workState('done', NOW - 60_000, { sessionId: null }), sessions: [session()] })).details).toContainEqual({ text: 'Last state: done · 1m', title: 'Last state: done', tone: 'dim' });
    expect(row(item(1, { status: 'finished', state: workState('done', NOW - 60_000, { sessionId: 'gone' }), sessions: [session()] })).details).toContainEqual({ text: 'Last state: done · 1m', title: 'Last state: done', tone: 'dim' });
    // A long headline is cut to 40 characters, with the whole in its title.
    expect(row(item(1, { state: workState(long, NOW - 60_000), sessions: [session()] })).details).toEqual([{ text: 'a headline that runs past the forty… · 1m', title: long, tone: null }]);
  });

  it('names the mark in words on line 3 when nothing else is there', () => {
    expect(row(item(1, { status: 'setup' })).details).toEqual([{ text: 'Setting up', title: null, tone: null }]);
    expect(row(item(1, { status: 'finished' })).details).toEqual([{ text: 'Review the turn', title: null, tone: null }]);
    expect(row(item(1, { status: 'setup', state: workState('creating the worktree', NOW - 60_000), sessions: [session()] })).details).toEqual([
      { text: 'creating the worktree · 1m', title: null, tone: null },
    ]);
    // An Unstarted row has no mark, so line 3 stays empty.
    expect(row(item(1, { status: 'unstarted' })).details).toEqual([]);
  });

  it('gives a row only the controls the hub runs, with their actions', () => {
    expect(row(item(7, { status: 'awaiting-approval', worktree, pastes: [{ id: 1, workItemId: 7, label: 'Reply', file: 'D:/r.md', reportedAt: NOW }] })).controls).toEqual([
      { label: 'Approve', glyph: '\u{eab2}', action: { type: 'approve', workItemId: 7 } },
      { label: 'Mark done', glyph: '\u{eba4}', action: { type: 'mark-done', workItemId: 7 } },
      { label: 'Snooze…', glyph: '\u{ec75}', action: { type: 'snooze', ticketId: 7 } },
      {
        label: 'Add comment…',
        glyph: '\u{ea6b}',
        action: { type: 'comment', workItemId: 7 },
        input: { question: 'Add comment', detail: expect.stringContaining('it is not sent to the ticket.') as string, field: 'text', action: 'Add' },
      },
      {
        label: 'Delete',
        glyph: '\u{ea81}',
        action: { type: 'delete', workItemId: 7 },
        confirm: { question: 'Delete gh 107?', detail: expect.stringContaining('Switchboard deletes the work item') as string, action: 'Delete' },
      },
    ]);
    expect(row(item(7, { sessions: [session()] })).controls.map((control) => control.label)).toEqual(['Stop session', 'Mark done', 'Snooze…', 'Add comment…', 'Delete']);
  });

  it("shows a snoozed row's wake time and then its comment on line 3, on one line and cut with the whole text as the tooltip (PRD R49)", () => {
    const long = `Waiting for the 4.2 release.\n${'Then ask the customer to retry the import once more. '.repeat(2)}`;
    const snoozed = (until: number | null, snoozeComment: string | null) => row(item(7, { status: 'unstarted', ticket: { ...item(7).ticket, snoozed: true, snoozedUntil: until, snoozeComment } }));
    const until = NOW + 86_400_000;

    expect(snoozed(until, null).details).toEqual([{ text: `Snoozed until ${wakeText(until)}`, title: null, tone: null }]);
    expect(snoozed(until, 'Waiting for the release.\nThen retry.').details).toEqual([
      { text: `Snoozed until ${new Date(until).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, title: `Snoozed until ${wakeText(until)}`, tone: null },
      { text: 'Waiting for the release. Then retry.', title: 'Waiting for the release.\nThen retry.', tone: null },
    ]);
    expect(snoozed(null, 'Later').details).toEqual([{ text: 'Later', title: 'Later', tone: null }]);
    expect(snoozed(null, null).details).toEqual([]);
    expect(snoozed(null, long).details[0]).toMatchObject({ title: long });
    expect(snoozed(null, long).details[0]!.text).toMatch(/^Waiting for the 4\.2 release\. Then .*…$/);
    expect(snoozed(null, long).details[0]!.text.length).toBeLessThanOrEqual(81);

    const view = dockView(snapshot([], { pool: [pool(4, { ticket: { ...pool(4).ticket, snoozed: true, snoozedUntil: null, snoozeComment: 'Customer is away' } })] }), NOW, W);
    expect(view.groups.find((group) => group.key === 'snoozed')!.rows[0]).toMatchObject({ details: [{ text: 'Customer is away', title: 'Customer is away', tone: null }], comment: null });
  });

  it("gives a work item row with comments line 2's comment icon, each comment under its time in the tooltip, oldest first (PRD R87)", () => {
    const comments = [
      { id: 1, workItemId: 7, at: NOW - 3_600_000, text: 'Waiting on Dana.' },
      { id: 2, workItemId: 7, at: NOW, text: 'Dana replied.\nRetry Monday.' },
    ];

    expect(row(item(7, { comments })).comment).toEqual({ glyph: '\u{ea6b}', title: `${wakeText(NOW - 3_600_000)}\nWaiting on Dana.\n\n${wakeText(NOW)}\nDana replied.\nRetry Monday.` });
    expect(row(item(7)).comment).toBeNull();
  });

  it('keeps a work item that failed at triage in Unstarted with its Failed mark, its error and Retry, but no stripe or turn (PRD R27, R34)', () => {
    const failed = item(7, { status: 'failed', error: 'Timed out.', playbook: null, triage: triage({ playbook: null, error: 'Timed out.' }) });

    expect(dockView(snapshot([failed]), NOW, W).groups.filter((group) => group.rows.length > 0).map((group) => group.key)).toEqual(['unstarted']);
    expect(row(failed)).toMatchObject({ mark: { kind: 'failed', glyph: '\u{ea87}' }, stripe: null, turn: null, main: 'Retry', mainGlyph: '\u{eb37}' });
    expect(row(failed).details).toEqual([{ text: 'Timed out.', title: null, tone: 'warning' }]);
    expect(row(failed).controls[0]).toEqual({ label: 'Retry', glyph: '\u{eb37}', action: { type: 'retry', workItemId: 7 } });

    const started = item(7, { status: 'failed', error: 'Workspace not trusted', triage: triage() });
    expect(dockView(snapshot([started]), NOW, W).groups.filter((group) => group.rows.length > 0).map((group) => group.key)).toEqual(['blocked']);
    expect(row(started)).toMatchObject({ mark: { kind: 'failed' }, stripe: 'error', turn: 'operator', main: 'Retry' });
  });

  it('opens the latest session when it is not running, and nothing while it runs', () => {
    expect(row(item(7, { sessions: [session({ codeMode: true, state: 'waiting' })] })).open).toEqual({ type: 'session', sessionId: 's1', cwd: 'D:/git/widgets', provider: 'claude' });
    expect(row(item(7, { sessions: [session({ state: 'waiting' })] })).open).toBeNull();
    expect(row(item(7, { status: 'blocked', sessions: [session({ state: 'ended' })] })).open).toEqual({ type: 'session', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', provider: 'claude' });
    expect(row(item(7, { sessions: [session({ state: 'idle', released: true })] })).open).toEqual({ type: 'session', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', provider: 'claude' });
    expect(row(item(7, { sessions: [session({ provider: 'codex', nativeSessionId: 'thread-1', state: 'ended' })] })).open).toEqual({ type: 'session', sessionId: 'thread-1', cwd: 'D:/git/widgets', provider: 'codex' });
    expect(row(item(7, { sessions: [session({ state: 'idle', released: true, releasing: true })] })).open).toBeNull();
    expect(row(item(7, { sessions: [session()] })).open).toBeNull();
    expect(row(item(7, { worktree })).open).toBeNull();
    expect(row(item(7, { status: 'unstarted' })).open).toEqual({ type: 'url', url: 'https://github.com/o/r/issues/107' });
    expect(row(item(7, { status: 'unstarted', ticket: { ...item(7).ticket, source: 'adhoc', url: '' }, focus: null })).open).toBeNull();
  });

  it('opens the focus of a row with no window, keeping the ticket URL for Open ticket (PRD R71, R79)', () => {
    const focus = 'https://github.com/o/r/issues/107#issuecomment-5';
    const unstarted = row(item(7, { status: 'unstarted', focus }));
    const pooled = dockView(snapshot([], { pool: [pool(4, { focus: 'https://github.com/o/r/issues/104#issuecomment-6' }), pool(5, { focus: null })] }), NOW, W).groups.flatMap((group) => group.rows);

    expect([unstarted.open, unstarted.url]).toEqual([{ type: 'url', url: focus }, 'https://github.com/o/r/issues/107']);
    expect(pooled.map((entry) => [entry.open, entry.url])).toEqual([
      [{ type: 'url', url: 'https://github.com/o/r/issues/104#issuecomment-6' }, 'https://github.com/o/r/issues/104'],
      [null, 'https://github.com/o/r/issues/105'],
    ]);
  });

  it('gives a row its main control, pastes, commands and search text', () => {
    const waiting = row(
      item(7, {
        worktree,
        sessions: [session({ codeMode: true, state: 'waiting' })],
        links: [{ id: 1, ticketId: 7, label: 'PR', target: 'https://github.com/o/r/pull/19002', reportedAt: NOW, mentioned: false }],
      }),
    );

    expect(waiting.main).toBe('Open in terminal');
    expect(waiting.mainTitle).toBe('Open in terminal: attaches to the Code Mode session');
    expect(waiting.mainGlyph).toBe('\u{ea85}');
    expect(waiting.commands).toEqual([
      { label: 'Open changes', glyph: '\u{ec23}', command: { type: 'changes', path: 'D:/git/widgets/.worktrees/107-fix', key: 'gh 107', title: 'Issue <7>' } },
      { label: 'History', glyph: '\u{ea82}', command: { type: 'history', ticketId: 7, key: 'gh 107' } },
    ]);
    expect(waiting.search).toBe('Issue <7> · gh 107 · PR #19002 · dev:develop · Blocked on you · 107-fix');

    const approval = row(item(7, { status: 'awaiting-approval', approvalReport: 'D:/drafts/reply.md', pastes: [{ id: 1, workItemId: 7, label: 'Reply', file: 'D:/r.md', reportedAt: NOW }] }));

    expect(approval.main).toBe('Approve');
    expect(approval.mainTitle).toBe('Approve');
    expect(approval.mainGlyph).toBe('\u{eab2}');
    expect(row(item(7, { status: 'awaiting-approval', approvalPrompt: '/review-pr pr:123 publish' })).mainTitle).toBe('Approve: runs /review-pr pr:123 publish');
    expect(approval.pastes).toEqual([{ label: 'Reply', file: 'D:/r.md' }]);
    expect(approval.commands).toEqual([
      { label: 'History', glyph: '\u{ea82}', command: { type: 'history', ticketId: 7, key: 'gh 107' } },
      { label: 'Open report', glyph: '\u{ea7b}', command: { type: 'openUrl', url: 'D:/drafts/reply.md' } },
    ]);
    expect(row(item(7, { status: 'blocked', pastes: [{ id: 1, workItemId: 7, label: 'Reply', file: 'D:/r.md', reportedAt: NOW }] })).pastes).toEqual([]);
    expect(row(item(7)).main).toBeNull();
    expect(row(item(7)).mainTitle).toBeNull();
    expect(row(item(7)).mainGlyph).toBeNull();
  });

  it('lists the sources and repo roots for the header', () => {
    const view = dockView(snapshot([], { sourceStates: [{ name: 'github', kind: 'github', label: 'github', enabled: true }, { name: 'zoho', kind: 'zoho', label: 'zoho', enabled: false }] }), NOW, W);

    expect(view.sources).toEqual([
      { kind: 'github', label: 'github', enabled: true, title: 'github: on\nClick to turn it off.', sources: [{ name: 'github', enabled: true }] },
      { kind: 'zoho', label: 'zoho', enabled: false, title: 'zoho: off\nClick to turn it on.', sources: [{ name: 'zoho', enabled: false }] },
    ]);
    expect(view.repoRoots).toEqual(['D:/git/widgets', 'D:/git/support']);
  });

  it("shows another repository's key by its short name and links by their repository, and keeps the window name of the stored key (PRD R27)", () => {
    const dashboard = item(8, { worktree });
    dashboard.ticket = { ...dashboard.ticket, sourceKey: 'acme/widgets-dashboard#63', repo: 'acme/widgets-dashboard' };
    dashboard.links = [
      { id: 1, ticketId: 8, label: 'Issue', target: 'https://github.com/Acme/Widgets/issues/5', reportedAt: NOW, mentioned: false },
      { id: 2, ticketId: 8, label: 'Issue', target: 'https://github.com/alice/tools/issues/6', reportedAt: NOW, mentioned: false },
      { id: 3, ticketId: 8, label: 'Issue', target: 'https://github.com/acme/widgets-dashboard/issues/7', reportedAt: NOW, mentioned: false },
    ];
    const keys = { homes: { github: 'acme/widgets' }, prefixes: { 'acme/widgets-dashboard': 'dash' } };
    const shown = (repoKeys?: typeof keys) => dockView(snapshot([dashboard], repoKeys === undefined ? {} : { repoKeys }), NOW, W).groups.flatMap((group) => group.rows)[0]!;

    expect(shown(keys)).toMatchObject({ ticket: 'dash 63', links: [{ label: 'gh 5', badge: '5' }, { label: 'alice/tools#6', badge: 'alice/tools#6' }, { label: 'dash 7', badge: 'dash 7' }] });
    // An issue in another GitHub source's home repository shows its number after GitHub's mark, that source's label read with it; a prefix that reads as a source's label stays.
    const homes = { homes: { github: 'acme/widgets', personal: 'alice/tools' }, prefixes: { 'acme/widgets-dashboard': 'gh' } };
    expect(shown(homes).links.map((link) => [link.label, link.badge])).toEqual([['gh 5', '5'], ['personal 6', '6'], ['gh 7', 'gh 7']]);
    // Without repository keys every issue is named by GitHub's label, which its mark stands for.
    expect(shown().links.map((link) => [link.label, link.badge])).toEqual([['gh 5', '5'], ['gh 6', '6'], ['gh 7', '7']]);
    expect(shown(keys).search).toContain('dash 63 · gh 5 · alice/tools#6 · dash 7');
    expect(shown(keys).window?.name).toMatch(/^gh-acme-widgets-dashboard-63-/);
    expect(shown(keys).window?.name).toBe(shown().window?.name);
    expect(shown().ticket).toBe('gh acme/widgets-dashboard#63');
  });

  it('groups the sources of one kind under one icon, which is on while any of them is polled (PRD R71)', () => {
    const groups = sourceGroups([
      { name: 'github', kind: 'github', label: 'GitHub', enabled: false },
      { name: 'zoho', kind: 'zoho', label: 'Zoho Desk', enabled: false },
      { name: 'personal', kind: 'github', label: 'GitHub', enabled: true },
    ]);

    expect(groups).toEqual([
      {
        kind: 'github',
        label: 'GitHub',

        enabled: true,
        title: 'github: off\npersonal: on\nClick to choose which are on.',
        sources: [
          { name: 'github', enabled: false },
          { name: 'personal', enabled: true },
        ],
      },
      { kind: 'zoho', label: 'Zoho Desk', enabled: false, title: 'zoho: off\nClick to turn it on.', sources: [{ name: 'zoho', enabled: false }] },
    ]);
    expect(sourceGroups([{ name: 'github', kind: 'github', label: 'github', enabled: false }, { name: 'personal', kind: 'github', label: 'github', enabled: false }])[0]!.enabled).toBe(false);
  });

  it('gives each row its source\'s kind, or the source name for a source no longer configured (PRD R3)', () => {
    const dashboard = item(8);
    dashboard.ticket = { ...dashboard.ticket, source: 'widgets-dashboard' };
    const removed = item(9);
    removed.ticket = { ...removed.ticket, source: 'forum' };
    const view = dockView(snapshot([dashboard, removed], { sourceStates: [{ name: 'widgets-dashboard', kind: 'github', label: 'github', enabled: true }] }), NOW, W);
    const rows = view.groups.flatMap((group) => group.rows);

    expect(rows.map((row) => [row.ticket, row.source, row.sourceKind])).toEqual([
      ['widgets-dashboard 108', 'widgets-dashboard', 'github'],
      ['forum 109', 'forum', 'forum'],
    ]);
  });

  it('gives a pool row its ticket, its triage state and its pool controls, and no window', () => {
    const view = dockView(snapshot([], { pool: [pool(4, { triage: triage({ playbook: null, endedAt: null }) }), pool(5, { triage: triage({ playbook: null, error: 'timed out' }) })] }), NOW, W);
    const [triaging, failed] = view.groups.find((group) => group.key === 'unstarted')!.rows;

    expect(triaging).toMatchObject({ key: 'ticket:4', playbook: 'dev:triage', mark: { kind: 'triaging', glyph: '\u{eb19}', title: 'Triaging' }, window: null, open: { type: 'url', url: 'https://github.com/o/r/issues/104' }, time: null });
    expect(triaging!.controls).toEqual([{ label: 'Snooze…', glyph: '\u{ec75}', action: { type: 'snooze', ticketId: 4 } }]);
    expect(triaging!.details).toEqual([{ text: 'Triaging', title: null, tone: null }]);
    expect(triaging!.main).toBeNull();
    expect(triaging!.commands).toEqual([{ label: 'History', glyph: '\u{ea82}', command: { type: 'history', ticketId: 4, key: 'gh 104' } }]);
    expect(failed!.main).toBe('Triage again');
    expect(failed!.details).toEqual([{ text: 'timed out', title: null, tone: 'warning' }]);
    expect(failed!.controls.map((control) => control.action)).toEqual([{ type: 'retriage-pool', ticketId: 5 }, { type: 'snooze', ticketId: 5 }]);
  });

  it('names each link once by its pull request or issue number, else its label, leaving out the ticket itself, mentioned links last, and carries Returned', () => {
    const link = (id: number, label: string, target: string, mentioned = false) => ({ id, ticketId: 7, label, target, reportedAt: NOW, mentioned });
    const shown = row(
      item(7, {
        links: [
          link(0, 'Issue #20087', 'https://github.com/o/r/issues/20087', true),
          link(1, 'Pull request', 'https://github.com/o/r/pull/19002'),
          link(2, 'Issue', 'https://github.com/o/r/issues/18941'),
          link(3, 'Design doc', 'https://example.test/doc'),
          link(4, 'Again', 'https://github.com/o/r/pull/19002'),
          link(5, 'Itself', 'https://github.com/o/r/issues/107'),
        ],
        returned: 3,
      }),
    );

    expect(shown.links).toEqual([
      { label: 'PR #19002', url: 'https://github.com/o/r/pull/19002', kind: 'pr', badge: '19002', glyph: '\u{ea64}', mentioned: false },
      { label: 'gh 18941', url: 'https://github.com/o/r/issues/18941', kind: 'issue', badge: '18941', glyph: '\u{ea84}', mentioned: false },
      { label: 'Design doc', url: 'https://example.test/doc', kind: 'url', badge: 'Design doc', glyph: '\u{eb15}', mentioned: false },
      { label: 'gh 20087', url: 'https://github.com/o/r/issues/20087', kind: 'issue', badge: '20087', glyph: '\u{ea84}', mentioned: true },
    ]);
    expect(shown.returned).toBe(3);
  });

  it("matches the recorded dockView output the page's rows are built from", () => {
    const fixture = new URL('./fixtures/dock-view.json', import.meta.url);
    const recorded = JSON.parse(readFileSync(fixture, 'utf8')) as unknown;
    const view = dockView(
      snapshot(
        [
          item(7, {
            status: 'finished',
            readyAt: NOW - 3 * 3_600_000,
            worktree,
            sessions: [session({ state: 'ended', cwd: worktree.path })],
            links: [
              { id: 1, ticketId: 7, label: 'Pull request', target: 'https://github.com/o/r/pull/19002', reportedAt: NOW, mentioned: false },
              { id: 2, ticketId: 7, label: 'Issue #20087', target: 'https://github.com/o/r/issues/20087', reportedAt: NOW, mentioned: true },
            ],
            returned: 2,
          }),
          item(8, { sessions: [session({ state: 'waiting', cwd: 'D:/git/widgets' })] }),
          item(9, { status: 'unstarted', triage: triage({ immediacy: 'BLOCKING', severity: 'MED' }), playbookChoices: ['dev:develop', 'dev:other'] }),
          item(10, {
            status: 'awaiting-approval',
            approvalPrompt: '/release-case #4521',
            approvalSummary: 'post the reply',
            approvalReport: 'D:/drafts/reply.md',
            pastes: [{ id: 1, workItemId: 10, label: 'Customer reply', file: 'D:/drafts/reply.md', reportedAt: NOW }],
            sessions: [session({ state: 'ended', cwd: 'D:/git/support' })],
          }),
          item(13, { status: 'running', readyAt: NOW - 5 * 3_600_000, orderAt: NOW - 6 * 3_600_000, state: workState('posting', NOW - 60_000), sessions: [session({ cwd: 'D:/git/widgets', codeMode: true })] }),
          item(14, { status: 'failed', error: 'Setup ended without a worktree.', statusAt: NOW - 600_000 }),
          item(15, { sessions: [session({ id: 'cm15', workItemId: 15, codeMode: true, state: 'waiting', nativeSessionId: 'eeee5555-native', shortId: 'eeee5555', cwd: 'D:/git/widgets' })] }),
          // Done rows carry their date band; 12:00 UTC less a minute is the same local day in any zone within ±11 hours.
          item(11, { status: 'done', doneAt: NOW - 60_000 }),
          item(12, { status: 'done', doneAt: NOW - 30 * 86_400_000 }),
        ],
        {
          pool: [pool(4)],
          sourceStates: [{ name: 'github', kind: 'github', label: 'GitHub', enabled: true }, { name: 'zoho', kind: 'zoho', label: 'Zoho Desk', enabled: false }],
          held: [
            { session: 'o1', label: 'switchboard · ad-hoc · adhoc 9 9273f594-1111', workItemId: null, key: 'adhoc 9', nativeSessionId: '9273f594-1111', cwd: 'D:/scratch', state: 'live', idleSince: NOW - 3 * 60_000, memoryBytes: 52_428_800, clients: 0, exitedAt: null, exitCode: null, orphan: true },
            { session: 'cm15', label: 'switchboard · dev:develop · gh 115 eeee5555-native', workItemId: 15, key: 'gh 115', nativeSessionId: 'eeee5555-native', cwd: 'D:/git/widgets', state: 'waiting', idleSince: NOW - 125 * 60_000, memoryBytes: 314_572_800, clients: 1, exitedAt: null, exitCode: null, orphan: false },
          ],
          holder: { build: 'aaaaaaaaaaaaaaaa', installed: 'bbbbbbbbbbbbbbbb', older: true, restart: { state: 'done', at: NOW - 60_000, resumed: 1, failed: [{ session: 's9', key: 'gh 109', error: 'Claude Code did not start.' }], error: null } },
        },
      ),
      NOW,
      W,
    );

    // The fixture was recorded on Windows; elsewhere the workspace file is joined to the windows folder with '/'.
    const built = JSON.parse(JSON.stringify(view).replaceAll(`${JSON.stringify(W).slice(1, -1)}/`, `${JSON.stringify(W).slice(1, -1)}\\\\`)) as unknown;

    expect(built).toEqual(recorded);
  });
});

describe('dockView of Code Mode sessions (PRD R95)', () => {
  const held = (patch: Partial<WorkItemView['sessions'][number]> = {}) => session({ codeMode: true, ...patch });
  const shown = (entry: WorkItemView, patch: Partial<Snapshot> = {}): DockRow => dockView(snapshot([entry], patch), NOW, W).groups.flatMap((group) => group.rows)[0]!;
  const base = windowOf(item(7, { sessions: [session()] }), W)!.name;
  const attach = { provider: 'claude', sessionId: 's1', cwd: 'D:/git/widgets', args: ['attach', 's1'], name: `${base}-s1`, title: `Issue <7> · sb:${base}-s1`, handoff: null, active: false, codeMode: true };
  const open = { type: 'session', sessionId: 's1', cwd: 'D:/git/widgets', provider: 'claude' };

  it('with always, leaves a turn in progress running and opens the attach terminal in the item window on a wait, after the turn and once ended', () => {
    expect(shown(item(7, { sessions: [held()] })).open).toBeNull();
    expect(shown(item(7, { sessions: [held({ state: 'starting', shortId: null })] })).open).toBeNull();
    expect(shown(item(7, { sessions: [held({ state: 'waiting' })] })).open).toEqual(open);
    expect(shown(item(7, { sessions: [held({ state: 'waiting', stateDetail: PERMISSION_PROMPT })] })).open).toEqual(open);
    expect(shown(item(7, { status: 'awaiting-approval', sessions: [held({ state: 'idle', releasing: true })] })).open).toEqual(open);
    expect(shown(item(7, { status: 'blocked', sessions: [held({ state: 'ended' })] })).open).toEqual(open);
  });

  it("names the terminal app window by the Switchboard session ID, so a Claude session ID change keeps it, and names Code Mode in the main control's tooltip", () => {
    const waiting = shown(item(7, { sessions: [held({ state: 'waiting' })] }));
    const changed = shown(item(7, { sessions: [held({ state: 'waiting', nativeSessionId: 'dddd4444-native', shortId: 'dddd4444' })] }));

    expect(waiting.terminal).toEqual(attach);
    expect(changed.terminal?.name).toBe(attach.name);
    expect(waiting.main).toBe('Open in terminal');
    expect(waiting.mainTitle).toBe('Open in terminal: attaches to the Code Mode session');
    expect(shown(item(7, { sessions: [held({ withoutCodeMode: true, state: 'waiting', stateDetail: PERMISSION_PROMPT })] })).mainTitle).toBe('Open in terminal: attaches to the session in the terminal holder');
  });

  it('opens the attach terminal in the terminal app, not the item window, with no Open in Claude', () => {
    const row = shown(item(7, { sessions: [held({ state: 'waiting' })] }));

    expect(row.terminal).toEqual(attach);
    expect(row.commands.map((command) => command.label)).not.toContain('Open in terminal');
    expect(row.controls.map((control) => control.label)).toContain('Stop session');
    expect(row.open?.type).not.toBe('question');
  });
});

describe('dockView held sessions (PRD R94)', () => {
  const entry = (patch: Partial<HeldSession> = {}): HeldSession => ({ session: 's1', label: 'dev · gh 107 aaaa1111-native', workItemId: 7, key: 'gh 107', nativeSessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', state: 'idle', idleSince: NOW - 125 * 60_000, memoryBytes: 300 * 1024 * 1024, clients: 1, exitedAt: null, exitCode: null, orphan: false, ...patch });
  const owner = item(7, { sessions: [session({ codeMode: true, state: 'idle' })] });
  const base = windowOf(owner, W)!.name;

  it('lists each held session with its columns, its work item by key and title, and the attach terminal of a session the store has', () => {
    expect(owner.ticket.title).not.toBe('');
    const view = dockView(snapshot([owner], { held: [entry()] }), NOW, W);

    expect(view.held).toEqual([
      {
        session: 's1',
        item: `gh 107 · ${owner.ticket.title}`,
        nativeSessionId: 'aaaa1111-native',
        cwd: 'D:/git/widgets',
        state: 'idle',
        idle: '2h 5m',
        memory: '300 MB',
        clients: 1,
        orphan: false,
        exited: false,
        terminal: { provider: 'claude', sessionId: 's1', cwd: 'D:/git/widgets', args: ['attach', 's1'], name: `${base}-s1`, title: `Issue <7> · sb:${base}-s1`, handoff: null, active: false, codeMode: true },
      },
    ]);
    expect('heldNote' in view).toBe(false);
  });

  it('gives an orphan no terminal and counts orphans in a note above the groups', () => {
    const orphan = entry({ session: 'o1', workItemId: null, key: 'gh 9', nativeSessionId: null, state: 'live', memoryBytes: null, exitedAt: NOW, orphan: true });
    const view = dockView(snapshot([owner], { held: [orphan, entry()] }), NOW, W);

    expect(view.held?.[0]).toMatchObject({ session: 'o1', item: 'No work item', nativeSessionId: '-', idle: '-', memory: '-', orphan: true, exited: true, terminal: null });
    expect(view.heldNote).toBe('1 background session without a work item');
    expect(dockView(snapshot([], { held: [orphan, { ...orphan, session: 'o2' }] }), NOW, W).heldNote).toBe('2 background sessions without a work item');
  });

  it("keeps an older held session's terminal name after a newer session starts in another folder", () => {
    const setup = session({ codeMode: true, state: 'idle', releasing: true });
    const before = dockView(snapshot([item(7, { sessions: [setup] })], { held: [entry()] }), NOW, W).held?.[0]?.terminal?.name;
    const after = dockView(snapshot([item(7, { worktree, sessions: [setup, session({ id: 's2', codeMode: true, cwd: worktree.path })] })], { held: [entry()] }), NOW, W).held?.[0]?.terminal?.name;

    expect(after).toBe(before);
    expect(after).toBe(`${base}-s1`);
  });

  it("gives a Codex app-server session's terminal no attach command, which takes only Code Mode sessions", () => {
    const codex = item(7, { sessions: [session({ provider: 'codex', execution: 'app-server', nativeSessionId: 'thread-1', state: 'idle' })] });

    expect(dockView(snapshot([codex], { held: [entry({ nativeSessionId: 'thread-1' })] }), NOW, W).held?.[0]).toMatchObject({ session: 's1', orphan: false, terminal: null });
  });
});

describe('dockView holder notice (architecture.md § Restarting the holder)', () => {
  const held = (session: string, patch: Partial<HeldSession> = {}): HeldSession => ({ session, label: '', workItemId: 7, key: 'gh 107', nativeSessionId: null, cwd: 'D:/git/widgets', state: 'idle', idleSince: NOW, memoryBytes: null, clients: 0, exitedAt: null, exitCode: null, orphan: false, ...patch });
  const older = { build: 'aaaaaaaaaaaaaaaa', installed: 'bbbbbbbbbbbbbbbb', older: true, restart: null };

  it('shows nothing without a holder, or for a holder of the installed build', () => {
    expect('holderNotice' in dockView(snapshot([]), NOW, W)).toBe(false);
    expect(dockView(snapshot([], { holder: { ...older, older: false } }), NOW, W)).not.toHaveProperty('holderNotice');
  });

  it('counts the sessions a restart resumes and names the ones it interrupts mid-turn, and the ones it ends', () => {
    const items = [
      item(7, { sessions: [session({ id: 's1', state: 'idle' })] }),
      item(8, { sessions: [session({ id: 's2', workItemId: 8, state: 'running' })] }),
      item(9, { sessions: [session({ id: 's3', workItemId: 9, state: 'waiting' })] }),
      item(10, { sessions: [session({ id: 's4', workItemId: 10, state: 'ended' })] }),
    ];
    const view = dockView(snapshot(items, { holder: older, held: [held('o1', { orphan: true, workItemId: null }), held('s1'), held('s2', { key: 'gh 108' }), held('s3', { key: 'gh 109' }), held('s4'), held('x1', { exitedAt: NOW })] }), NOW, W);

    expect(view.holderNotice).toEqual({
      text: 'The terminal holder that runs background sessions is out of date. Restart it to update; its 3 sessions stop and resume.',
      confirm: {
        question: 'Restart the terminal holder?',
        detail: 'Restarting stops the 3 background sessions and resumes them in a holder of the installed build. These sessions are not idle, so the restart interrupts their turns: Issue <8> (gh 108), Issue <9> (gh 109). 2 other background sessions end and are not resumed.',
        action: 'Restart and resume',
      },
    });
    expect(view).not.toHaveProperty('holderResult');

    const one = dockView(snapshot([items[1]!], { holder: older, held: [held('s2', { key: 'gh 108' })] }), NOW, W);

    expect(one.holderNotice?.text).toBe('The terminal holder that runs background sessions is out of date. Restart it to update; its 1 session stops and resumes.');
    expect(one.holderNotice?.confirm?.detail).toBe('Restarting stops the background session and resumes it in a holder of the installed build. This session is not idle, so the restart interrupts its turn: Issue <8> (gh 108).');

    const none = dockView(snapshot([], { holder: older }), NOW, W);

    expect(none.holderNotice).toMatchObject({ text: 'The terminal holder that runs background sessions is out of date. Restart it to update.', confirm: { detail: 'The terminal holder holds no live session.' } });
    expect(dockView(snapshot([], { holder: older, held: [held('o1', { orphan: true, workItemId: null })] }), NOW, W).holderNotice?.confirm?.detail).toBe('1 background session ends and is not resumed.');
  });

  it('offers no restart while one runs, and shows the last result, failed when the holder or a session failed', () => {
    const running = dockView(snapshot([], { holder: { ...older, restart: { state: 'running', at: NOW } } }), NOW, W);

    expect(running.holderNotice).toEqual({ text: 'Restarting the terminal holder and resuming its sessions…', confirm: null });

    const done = { state: 'done' as const, at: NOW, resumed: 2, failed: [], error: null };

    expect(dockView(snapshot([], { holder: { ...older, older: false, restart: done } }), NOW, W)).toMatchObject({ holderResult: { at: NOW, text: 'The terminal holder restarted and 2 sessions resumed.', failed: false } });
    expect(dockView(snapshot([], { holder: { ...older, older: false, restart: { ...done, resumed: 0 } } }), NOW, W).holderResult?.text).toBe('The terminal holder restarted.');

    const partly = dockView(snapshot([], { holder: { ...older, older: false, restart: { ...done, resumed: 1, failed: [{ session: 's2', key: 'gh 108', error: 'Claude Code did not start.' }] } } }), NOW, W);

    expect(partly.holderResult).toEqual({ at: NOW, text: 'The terminal holder restarted and 1 session resumed. 1 session did not resume: gh 108: Claude Code did not start.', failed: true });

    // A failed restart leaves the old holder, so the notice offers it again beside the result.
    const failed = dockView(snapshot([], { holder: { ...older, restart: { ...done, resumed: 1, error: 'The terminal holder (pid 4) did not exit and could not be ended: Access is denied.' } } }), NOW, W);

    expect(failed.holderResult).toEqual({ at: NOW, text: 'The terminal holder did not restart: The terminal holder (pid 4) did not exit and could not be ended: Access is denied. 1 session resumed.', failed: true });
    expect(failed.holderNotice?.confirm).not.toBeNull();
  });
});

describe('dockView Open in terminal (PRD R28)', () => {
  const shown = (entry: WorkItemView): DockRow => dockView(snapshot([entry]), NOW, W).groups.flatMap((group) => group.rows)[0]!;
  const ended = item(7, { status: 'blocked', sessions: [session({ state: 'ended' })] });
  const base = windowOf(item(7, { sessions: [session()] }), W)!.name;
  const terminalLabels = (row: DockRow) => row.commands.filter((command) => command.command['type'] === 'terminal').map((command) => command.label);

  it("opens Open in terminal in the terminal app, never in the item window, and leaves the click and the item window's other commands", () => {
    const app = shown(ended);

    expect(app.terminal).toEqual({ provider: 'claude', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', args: ['--resume', 'aaaa1111-native'], name: `${base}-aaaa1111`, title: `Issue <7> · sb:${base}-aaaa1111`, handoff: null, active: false });
    expect(terminalLabels(app)).toEqual([]);
    expect(app.commands.map((command) => command.label)).toContain('History');
    expect(app.open).toEqual({ type: 'session', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', provider: 'claude' });
  });

  it("keeps a prompt before start's Open in terminal as the main control and attaches in the terminal app", () => {
    const starting = shown(item(7, { sessions: [session({ codeMode: true, state: 'waiting', stateDetail: 'start-prompt' })] }));

    expect(starting.main).toBe('Open in terminal');
    expect(starting.terminal).toMatchObject({ args: ['attach', 's1'] });
    expect(terminalLabels(starting)).toEqual([]);
  });

  it('offers no terminal while the session starts', () => {
    expect(shown(item(7, { sessions: [session({ state: 'starting', shortId: null })] })).terminal).toBeNull();
  });
});

describe('CONTROL_GLYPHS', () => {
  it('matches the codepoints of @vscode/codicons for every control icon', () => {
    const csv = readFileSync(new URL('../../../node_modules/@vscode/codicons/dist/codicon.csv', import.meta.url), 'utf8');
    const codepoints = new Map(csv.split('\n').slice(1).map((line) => line.split(',')).map(([name, , hex]) => [name!, hex?.trim().toLowerCase()]));

    expect(Object.entries(CONTROL_GLYPHS).map(([name, glyph]) => [name, glyph.codePointAt(0)!.toString(16)])).toEqual(Object.keys(CONTROL_GLYPHS).map((name) => [name, codepoints.get(name)]));
  });
});

describe('windowOf', () => {
  it('shows an idle folder-hosted Codex conversation with the Idle mark and no turn', () => {
    const host = 'D:\\git\\switchboard';
    const hosted = item(22, { ticket: { ...item(22).ticket, source: 'adhoc', sourceKey: '22', url: '', hostWindow: host }, focus: null, sessions: [session({ provider: 'codex', execution: 'app-server', promptless: true, state: 'idle', cwd: host })] });
    const row = dockView(snapshot([hosted]), NOW, W).groups.flatMap(group => group.rows)[0]!;
    expect(row.mark).toEqual({ kind: 'idle', glyph: '\u{ebb5}', title: 'Idle' });
    expect(row.turn).toBeNull();
    expect(row.window).toEqual({ name: 'switchboard', title: hosted.ticket.title, folders: [host], file: null, hosted: true, folder: host });
    expect(row.open).toMatchObject({ type: 'session', provider: 'codex' });
  });
  it("opens a hosted conversation in its host's workspace file, which is not its own (architecture.md § Hosted conversations)", () => {
    const host = 'C:/sb/windows/GH-7-widgets-655280.code-workspace';
    const hosted = item(9, { ticket: { ...item(9).ticket, source: 'adhoc', sourceKey: '4', url: '', hostWindow: host }, focus: null, sessions: [session({ cwd: 'D:/git/support' })] });
    const primary = item(7, { sessions: [session({ cwd: 'D:/git/support' })] });

    expect(windowOf(hosted, W)).toEqual({ name: 'GH-7-widgets-655280', title: hosted.ticket.title, folders: ['D:/git/support'], file: host, hosted: true });
    expect(windowOf(primary, W)!.file).not.toBe(host);
  });

  it("opens a conversation whose host is no path, such as a web page's key, in its own folder, never in a workspace file named after the key", () => {
    const key = 'a3f9c0de11b2a3f9c0de11b2a3f9c0de11b2a3f9c0de11b2';
    const ticket = { ...item(9).ticket, source: 'adhoc', sourceKey: '4', url: '', hostWindow: key, repoRoot: 'D:/git/root' };
    const hosted = item(9, { ticket, focus: null, sessions: [session({ cwd: 'D:\\git\\support' })] });

    expect(windowOf(hosted, W)).toEqual({ name: 'support', title: hosted.ticket.title, folders: ['D:\\git\\support'], file: null, hosted: true, folder: 'D:\\git\\support' });
    // Before its first session, its ticket's repository root.
    expect(windowOf(item(9, { ticket, focus: null }), W)).toMatchObject({ folders: ['D:/git/root'], file: null, folder: 'D:/git/root' });
    expect(windowOf(item(9, { ticket: { ...ticket, repoRoot: '' }, focus: null }), W)).toBeNull();
  });

  it('opens a folder-hosted conversation in its folder, with no workspace file, and never in the workspace file of a work item on that folder (architecture.md § Hosted conversations)', () => {
    const host = 'D:\\git\\support';
    const hosted = item(9, { ticket: { ...item(9).ticket, source: 'adhoc', sourceKey: '4', url: '', hostWindow: host }, focus: null, sessions: [session({ cwd: host })] });
    const primary = item(7, { sessions: [session({ cwd: host })] });

    expect(windowOf(hosted, W)).toEqual({ name: 'support', title: hosted.ticket.title, folders: [host], file: null, hosted: true, folder: host });
    expect(windowOf(primary, W)!.file).toMatch(/\.code-workspace$/);
  });

  it('opens the latest session folder first, with the worktree second when the session ran elsewhere', () => {
    expect(windowOf(item(7, { worktree, sessions: [session({ cwd: 'D:\\git\\widgets\\.worktrees\\107-fix\\' })] }), W)).toEqual({
      name: 'gh-107-9a479b',
      title: 'Issue <7>',
      folders: ['D:\\git\\widgets\\.worktrees\\107-fix\\'],
      file: join(W, 'gh-107-9a479b.code-workspace'),
    });
    expect(windowOf(item(7, { worktree, sessions: [session({ cwd: 'D:/git/widgets' })] }), W)).toEqual({
      name: 'gh-107-widgets-760e0e',
      title: 'Issue <7>',
      folders: ['D:/git/widgets', 'D:/git/widgets/.worktrees/107-fix'],
      file: join(W, 'gh-107-widgets-760e0e.code-workspace'),
    });
    expect(windowOf(item(7, { worktree }), W)).toEqual({
      name: 'gh-107-9a479b',
      title: 'Issue <7>',
      folders: ['D:/git/widgets/.worktrees/107-fix'],
      file: join(W, 'gh-107-9a479b.code-workspace'),
    });
    expect(windowOf(item(7, { sessions: [session({ cwd: 'D:/git/support' })], ticket: { ...item(7).ticket, source: 'zoho', sourceKey: '4521/a b' } }), W)).toEqual({
      name: 'zoho-4521-a-b-support-d24afb',
      title: 'Issue <7>',
      folders: ['D:/git/support'],
      file: join(W, 'zoho-4521-a-b-support-d24afb.code-workspace'),
    });
    expect(windowOf(item(7), W)).toBeNull();
  });

  it('names an ad-hoc row by how it was made, and a scheduled row by its playbook (PRD R27, R82)', () => {
    const adhoc = { ...item(7).ticket, source: 'adhoc', sourceKey: '3', url: '' };

    expect(row(item(7, { status: 'unstarted', playbook: null, taskPrompt: 'Fix it', ticket: adhoc, focus: null })).playbook).toBe('ad-hoc');
    expect(row(item(7, { status: 'unstarted', playbook: null, taskPrompt: 'Fix it', parentId: 2, ticket: adhoc, focus: null })).playbook).toBe('task');
    expect(row(item(7, { playbook: null, taskPrompt: null, ticket: adhoc, focus: null })).playbook).toBe('registered');
    expect(row(item(7, { status: 'unstarted', playbook: 'ops:cleanup', ticket: { ...adhoc, source: 'schedule', sourceKey: 'cleanup' }, focus: null })).ticket).toBe('schedule cleanup');
  });

  it('keeps the ad-hoc label and item window name of a work item a ticket report moved, and names the ticket by its new key (PRD R83)', () => {
    const adhoc = { ...item(7).ticket, source: 'adhoc', sourceKey: '3', url: '' };
    const moved = { ...item(7).ticket, source: 'github', sourceKey: '115', adhocKey: '3' };
    const ended = [session({ state: 'ended', cwd: 'D:/git/widgets' })];
    const before = windowOf(item(7, { ticket: adhoc, sessions: ended }), W)!;
    const after = windowOf(item(7, { ticket: moved, sessions: ended }), W)!;

    expect(row(item(7, { playbook: null, taskPrompt: null, ticket: moved, moved: true, focus: null })).playbook).toBe('registered');
    expect(row(item(7, { playbook: null, taskPrompt: null, ticket: moved, moved: true, focus: null })).ticket).toBe('gh 115');
    // A later work item of the ticket whose triage chose no playbook is unnamed, not registered.
    expect(row(item(8, { status: 'failed', playbook: null, taskPrompt: null, ticket: moved, moved: false, focus: null })).playbook).toBe('');
    expect(after.name).toMatch(/^adhoc-3-widgets-[0-9a-f]{6}$/);
    expect(after.name).toBe(before.name);
    expect(after.file).toBe(before.file);
  });

  it('gives a registered session no item window or terminal while it lives in the operator window, and both once it ends (PRD R81)', () => {
    const adhoc = { ...item(7).ticket, source: 'adhoc', sourceKey: '3', url: '' };
    const live = item(7, { ticket: adhoc, focus: null, sessions: [session({ released: true, external: true, cwd: 'D:/git/widgets' })] });
    const ended = item(7, { ticket: adhoc, focus: null, status: 'blocked', sessions: [session({ released: true, external: false, state: 'ended', cwd: 'D:/git/widgets' })] });
    const terminal = (entry: WorkItemView) => row(entry).terminal !== null;

    expect(windowOf(live, W)).toBeNull();
    expect(row(live)).toMatchObject({ window: null, open: null });
    expect(terminal(live)).toBe(false);
    expect(windowOf(ended, W)).toMatchObject({ folders: ['D:/git/widgets'] });
    expect(row(ended).open).toMatchObject({ type: 'session', sessionId: 'aaaa1111-native' });
    expect(terminal(ended)).toBe(true);
  });

  it('gives each first folder its own name, so a window never changes its first folder', () => {
    const names = ['D:/one/review', 'D:/two/review'].map((cwd) => windowOf(item(7, { sessions: [session({ cwd })] }), W)!.name);
    const moved = windowOf(item(7, { worktree: { ...worktree, path: 'E:/wt/107-fix' } }), W)!.name;

    expect(names[0]).toMatch(/^gh-107-review-[0-9a-f]{6}$/);
    expect(names[1]).toMatch(/^gh-107-review-[0-9a-f]{6}$/);
    expect(names[0]).not.toBe(names[1]);
    expect(moved).toMatch(/^gh-107-[0-9a-f]{6}$/);
    expect(moved).not.toBe('gh-107-9a479b');
  });
});

describe('workspace files', () => {
  const window = { name: 'gh-107-widgets', title: 'Fix ${x} badge for $5', folders: ['D:/git/widgets', 'D:/git/widgets/.worktrees/107-fix'], file: '' };

  it('lists the folders, ends the title with the window name, replacing each $ in the ticket title, and turns off recommendation prompts', () => {
    expect(workspaceText(window)).toBe(
      [
        '{',
        '  "folders": [',
        '    {',
        '      "path": "D:/git/widgets"',
        '    },',
        '    {',
        '      "path": "D:/git/widgets/.worktrees/107-fix"',
        '    }',
        '  ],',
        '  "settings": {',
        '    "window.title": "Fix ＄{x} badge for ＄5${separator}${activeEditorShort}${separator}sb:gh-107-widgets",',
        '    "window.titleSeparator": " · ",',
        '    "extensions.ignoreRecommendations": true',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('is under the Switchboard home', () => {
    expect(windowsDir('C:/Users/op')).toBe(join('C:/Users/op', '.switchboard', 'windows'));
  });

  it('writes a file only when its text changed', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'switchboard-windows-')), 'windows', 'gh-107-widgets.code-workspace');
    const written = new Map<string, string>();
    const past = new Date(Date.now() - 3_600_000);

    writeWorkspaceFile({ ...window, file }, written);
    utimesSync(file, past, past);
    writeWorkspaceFile({ ...window, file }, new Map());
    expect(statSync(file).mtimeMs).toBe(past.getTime());

    writeWorkspaceFile({ ...window, file, title: 'Renamed' }, written);
    expect(readFileSync(file, 'utf8')).toContain('Renamed');
  });

  it('rewrites a file changed on disk when no cache holds it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'switchboard-windows-')), 'gh-107-widgets.code-workspace');

    writeWorkspaceFile({ ...window, file });
    writeFileSync(file, 'edited');
    writeWorkspaceFile({ ...window, file });
    expect(readFileSync(file, 'utf8')).toBe(workspaceText(window));
  });
});


describe('a row waiting on a usage limit (architecture.md § Rate limits)', () => {
  it('stays In progress on the agent\'s turn, with the Rate limited mark and when it resumes on line 3', () => {
    const resetsAt = NOW + 3_600_000;
    const limited = row(item(1, { status: 'running', state: workState('2/5 finding defects', NOW), sessions: [session({ codeMode: true, state: 'failed', stateDetail: 'rate_limit', rateLimit: { kind: 'usage', window: 'five_hour', resetsAt, exact: true, cli: true, message: 'limit', since: NOW, at: NOW, launchId: 'l', attempts: 0, nextAt: resetsAt + 180_000 } })] }));

    expect(limited).toMatchObject({ mark: { kind: 'limited', glyph: '\u{eb7c}', title: 'Usage limit' }, stripe: null, turn: 'agent' });
    expect(limited.details[0]?.text).toMatch(/^Usage limit · resumes \d{1,2}:\d{2} [AP]M$/);
    expect(dockView(snapshot([item(1, { status: 'running', sessions: [session({ codeMode: true, state: 'failed', stateDetail: 'rate_limit', rateLimit: { kind: 'usage', window: null, resetsAt: null, exact: false, cli: false, message: null, since: NOW, at: NOW, launchId: 'l', attempts: 0, nextAt: NOW + 300_000 } })] })]), NOW, W).groups.find((group) => group.rows.length > 0)?.key).toBe('progress');
  });
});
