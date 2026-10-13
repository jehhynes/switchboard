import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockView, windowOf, windowsDir, windowTabs, workspaceText, writeWorkspaceFile } from '../src/dock.js';
import type { DockRow } from '../src/dock.js';
import { CONTROL_GLYPHS } from '../src/rows.js';
import type { WorkItemView } from '../src/runtime.js';
import { item, NOW, pool, session, snapshot, triage } from './views.js';

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
      ['Next week', 'Mon, Oct 5, 6:00 AM', Date.UTC(2026, 9, 5, 6)],
      ['In 2 weeks', 'Mon, Oct 12, 6:00 AM', Date.UTC(2026, 9, 12, 6)],
      ['In 4 weeks', 'Mon, Oct 26, 6:00 AM', Date.UTC(2026, 9, 26, 6)],
      ['Indefinitely', '', null],
    ]);
  });

  it('lists the groups in order, with Snoozed before Done and only when it has rows', () => {
    const view = dockView(snapshot([item(1, { status: 'blocked' }), item(2), item(3, { status: 'unstarted' })], { pool: [pool(4)] }), NOW, W);

    expect(view.groups.map((group) => [group.key, group.title, group.empty, group.rows.map((entry) => entry.key)])).toEqual([
      ['review', 'Ready for review', 'Nothing is ready for review.', []],
      ['blocked', 'Blocked on you', null, ['item:1']],
      ['progress', 'In progress', 'Nothing is in progress.', ['item:2']],
      ['unstarted', 'Unstarted', 'Nothing waits to be started.', ['item:3', 'ticket:4']],
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
      'No source is polled. Turn one on in the header.',
    ]);
  });

  it('gives a row the panel texts: title, priority, time, playbook, key, mark and line 3', () => {
    const waiting = row(
      item(7, {
        triage: triage({ immediacy: 'URGENT', severity: 'HIGH' }),
        warning: 'Ticket left the assigned state',
        sessions: [session({ state: 'waiting', stateAt: NOW - 25 * 60_000 })],
        stage: 'checking refunds',
        stageAt: NOW - 30 * 60_000,
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
    // The question is answered in Claude, so line 3 names the mark in place of the stage.
    expect(row(item(7, { sessions: [session({ state: 'waiting' })], stage: 'checking refunds', stageAt: NOW - 60_000 })).details).toEqual([{ text: 'Answer a question', title: null, tone: null }]);
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

  it('names the mark in words on line 3 when nothing else is there', () => {
    expect(row(item(1, { status: 'setup' })).details).toEqual([{ text: 'Setting up', title: null, tone: null }]);
    expect(row(item(1, { status: 'finished' })).details).toEqual([{ text: 'Review the finished turn', title: null, tone: null }]);
    expect(row(item(1, { status: 'setup', stage: 'creating the worktree', stageAt: NOW - 60_000, sessions: [session()] })).details).toEqual([
      { text: 'creating the worktree · 1m', title: null, tone: null },
    ]);
    // An Unstarted row has no mark, so line 3 stays empty.
    expect(row(item(1, { status: 'unstarted' })).details).toEqual([]);
  });

  it('gives a row only the controls the hub runs, with their actions', () => {
    expect(row(item(7, { status: 'awaiting-approval', worktree, pastes: [{ id: 1, workItemId: 7, label: 'Reply', file: 'D:/r.md', reportedAt: NOW }] })).controls).toEqual([
      { label: 'Approve', glyph: '\u{eab2}', action: { type: 'approve', workItemId: 7 } },
      { label: 'Triage again', glyph: '\u{ea6d}', action: { type: 'retriage', workItemId: 7 } },
      { label: 'Mark done', glyph: '\u{eba4}', action: { type: 'mark-done', workItemId: 7 } },
      { label: 'Snooze', glyph: '\u{ec75}', action: { type: 'snooze', ticketId: 7 } },
      {
        label: 'Delete',
        glyph: '\u{ea81}',
        action: { type: 'delete', workItemId: 7 },
        confirm: { question: 'Delete gh 107?', detail: expect.stringContaining('Switchboard deletes the work item') as string, action: 'Delete' },
      },
    ]);
    expect(row(item(7, { sessions: [session()] })).controls.map((control) => control.label)).toEqual(['Stop', 'Mark done', 'Snooze', 'Delete']);
  });

  it('opens Open in Claude for a waiting background session, the latest session when it is not running, and nothing while it runs', () => {
    expect(row(item(7, { sessions: [session({ state: 'waiting' })] })).open).toEqual({ type: 'question', workItemId: 7, sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', provider: 'claude' });
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

  it('gives a row its main control, pastes, VS Code commands and search text', () => {
    const waiting = row(
      item(7, {
        worktree,
        sessions: [session({ state: 'waiting' })],
        links: [{ id: 1, ticketId: 7, label: 'PR', target: 'https://github.com/o/r/pull/19002', reportedAt: NOW }],
      }),
    );

    expect(waiting.main).toBe('Open in Claude');
    expect(waiting.mainTitle).toBe('Open in Claude');
    expect(waiting.mainGlyph).toBe('\u{eac7}');
    expect(waiting.commands).toEqual([
      { label: 'Open Changes', glyph: '\u{ec23}', command: { type: 'changes', path: 'D:/git/widgets/.worktrees/107-fix', key: 'gh 107', title: 'Issue <7>' } },
      { label: 'Open in terminal', glyph: '\u{ea85}', command: { type: 'terminal', provider: 'claude', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', name: 'gh 107', shortId: 'aaaa1111', active: false } },
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
    const view = dockView(snapshot([], { sourceStates: [{ name: 'github', enabled: true }, { name: 'zoho', enabled: false }] }), NOW, W);

    expect(view.sources).toEqual([{ name: 'github', enabled: true }, { name: 'zoho', enabled: false }]);
    expect(view.repoRoots).toEqual(['D:/git/widgets', 'D:/git/support']);
  });

  it('gives a pool row its ticket, its triage state and its pool controls, and no window', () => {
    const view = dockView(snapshot([], { pool: [pool(4, { triage: triage({ playbook: null, endedAt: null }) }), pool(5, { triage: triage({ playbook: null, error: 'timed out' }) })] }), NOW, W);
    const [triaging, failed] = view.groups.find((group) => group.key === 'unstarted')!.rows;

    expect(triaging).toMatchObject({ key: 'ticket:4', playbook: 'dev:triage', mark: { kind: 'triaging', glyph: '\u{eb19}', title: 'Triaging' }, window: null, open: { type: 'url', url: 'https://github.com/o/r/issues/104' }, time: null });
    expect(triaging!.controls).toEqual([{ label: 'Snooze', glyph: '\u{ec75}', action: { type: 'snooze', ticketId: 4 } }]);
    expect(triaging!.details).toEqual([{ text: 'Triaging', title: null, tone: null }]);
    expect(triaging!.main).toBeNull();
    expect(triaging!.commands).toEqual([{ label: 'History', glyph: '\u{ea82}', command: { type: 'history', ticketId: 4, key: 'gh 104' } }]);
    expect(failed!.main).toBe('Triage again');
    expect(failed!.details).toEqual([{ text: 'timed out', title: null, tone: 'warning' }]);
    expect(failed!.controls.map((control) => control.action)).toEqual([{ type: 'retriage-pool', ticketId: 5 }, { type: 'snooze', ticketId: 5 }]);
  });

  it('names each link once by its pull request or issue number, else its label, leaving out the ticket itself, and carries Returned', () => {
    const link = (id: number, label: string, target: string) => ({ id, ticketId: 7, label, target, reportedAt: NOW });
    const shown = row(
      item(7, {
        links: [
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
      { label: 'PR #19002', url: 'https://github.com/o/r/pull/19002', kind: 'pr', badge: '19002', glyph: '\u{ea64}' },
      { label: 'gh 18941', url: 'https://github.com/o/r/issues/18941', kind: 'issue', badge: 'gh 18941', glyph: null },
      { label: 'Design doc', url: 'https://example.test/doc', kind: 'url', badge: 'Design doc', glyph: '\u{eb15}' },
    ]);
    expect(shown.returned).toBe(3);
  });

  it('matches the recorded dock message the dock app reads', () => {
    const recorded = JSON.parse(readFileSync(new URL('../../../apps/dock/test/fixtures/dock.json', import.meta.url), 'utf8')) as unknown;
    const view = dockView(
      snapshot(
        [
          item(7, {
            status: 'finished',
            readyAt: NOW - 3 * 3_600_000,
            worktree,
            sessions: [session({ state: 'ended', cwd: worktree.path })],
            links: [{ id: 1, ticketId: 7, label: 'Pull request', target: 'https://github.com/o/r/pull/19002', reportedAt: NOW }],
            returned: 2,
          }),
          item(8, { sessions: [session({ state: 'waiting', cwd: 'D:/git/widgets' })] }),
          item(9, { status: 'unstarted', triage: triage({ immediacy: 'BLOCKING', severity: 'MED' }) }),
          item(10, {
            status: 'awaiting-approval',
            approvalPrompt: '/support-release #4521',
            approvalSummary: 'post the reply',
            approvalReport: 'D:/drafts/reply.md',
            pastes: [{ id: 1, workItemId: 10, label: 'Customer reply', file: 'D:/drafts/reply.md', reportedAt: NOW }],
            sessions: [session({ state: 'ended', cwd: 'D:/git/support' })],
          }),
          item(13, { status: 'running', readyAt: NOW - 5 * 3_600_000, orderAt: NOW - 6 * 3_600_000, stage: 'posting', stageAt: NOW - 60_000, sessions: [session({ cwd: 'D:/git/widgets' })] }),
          item(14, { status: 'failed', error: 'Setup ended without a worktree.', statusAt: NOW - 600_000 }),
          // Done rows carry their date band; 12:00 UTC less a minute is the same local day in any zone within ±11 hours.
          item(11, { status: 'done', doneAt: NOW - 60_000 }),
          item(12, { status: 'done', doneAt: NOW - 30 * 86_400_000 }),
        ],
        { pool: [pool(4)], sourceStates: [{ name: 'github', enabled: true }, { name: 'zoho', enabled: false }] },
      ),
      NOW,
      W,
    );

    expect(view).toEqual(recorded);
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
  it('opens the latest session folder first, with the worktree second when the session ran elsewhere', () => {
    expect(windowOf(item(7, { worktree, sessions: [session({ cwd: 'D:\\git\\widgets\\.worktrees\\107-fix\\' })] }), W)).toEqual({
      name: 'gh-107-58c609',
      title: 'Issue <7>',
      folders: ['D:\\git\\widgets\\.worktrees\\107-fix\\'],
      file: `${W}\\gh-107-58c609.code-workspace`,
    });
    expect(windowOf(item(7, { worktree, sessions: [session({ cwd: 'D:/git/widgets' })] }), W)).toEqual({
      name: 'gh-107-widgets-655280',
      title: 'Issue <7>',
      folders: ['D:/git/widgets', 'D:/git/widgets/.worktrees/107-fix'],
      file: `${W}\\gh-107-widgets-655280.code-workspace`,
    });
    expect(windowOf(item(7, { worktree }), W)).toEqual({
      name: 'gh-107-58c609',
      title: 'Issue <7>',
      folders: ['D:/git/widgets/.worktrees/107-fix'],
      file: `${W}\\gh-107-58c609.code-workspace`,
    });
    expect(windowOf(item(7, { sessions: [session({ cwd: 'D:/git/support' })], ticket: { ...item(7).ticket, source: 'zoho', sourceKey: '4521/a b' } }), W)).toEqual({
      name: 'zoho-4521-a-b-support-c6262c',
      title: 'Issue <7>',
      folders: ['D:/git/support'],
      file: `${W}\\zoho-4521-a-b-support-c6262c.code-workspace`,
    });
    expect(windowOf(item(7), W)).toBeNull();
  });

  it('gives each first folder its own name, so a window never changes its first folder', () => {
    const names = ['D:/one/review', 'D:/two/review'].map((cwd) => windowOf(item(7, { sessions: [session({ cwd })] }), W)!.name);
    const moved = windowOf(item(7, { worktree: { ...worktree, path: 'E:/wt/107-fix' } }), W)!.name;

    expect(names[0]).toMatch(/^gh-107-review-[0-9a-f]{6}$/);
    expect(names[1]).toMatch(/^gh-107-review-[0-9a-f]{6}$/);
    expect(names[0]).not.toBe(names[1]);
    expect(moved).toMatch(/^gh-107-[0-9a-f]{6}$/);
    expect(moved).not.toBe('gh-107-58c609');
  });
});

describe('windowTabs', () => {
  const file = `${W}\\gh-107-58c609.code-workspace`;
  const link = (id: number, target: string) => ({ id, ticketId: 7, label: 'Link', target, reportedAt: NOW });

  it("lists each window work item's focus, not its links, then an awaiting-approval report, each once (PRD R72, R79)", () => {
    const links = [link(1, 'https://github.com/o/r/issues/900'), link(2, 'https://github.com/o/r/pull/19002')];
    const earlier = item(6, { status: 'done', worktree, links, ticket: item(7).ticket, focus: 'https://github.com/o/r/pull/19002#discussion_r4' });
    const current = item(7, { status: 'awaiting-approval', approvalReport: 'D:/drafts/reply.md', worktree, links });
    const tabs = {
      focuses: [
        { workItemId: 6, url: 'https://github.com/o/r/pull/19002#discussion_r4' },
        { workItemId: 7, url: 'https://github.com/o/r/issues/107' },
      ],
      reports: ['D:/drafts/reply.md'],
    };

    expect(windowTabs(snapshot([earlier, current]), file, W)).toEqual(tabs);
    // The path compares as Windows does: case, slashes and a trailing separator do not matter.
    expect(windowTabs(snapshot([earlier, current]), `${W.toUpperCase().replaceAll('\\', '/')}/GH-107-58c609.code-workspace/`, W)).toEqual(tabs);
  });

  it('leaves out a report once its work item no longer awaits approval, another window and a work item with no focus', () => {
    const blocked = item(7, { status: 'blocked', approvalReport: 'D:/drafts/reply.md', worktree });
    const other = item(8, { worktree: { ...worktree, ticketId: 8, path: 'D:/git/widgets/.worktrees/108-fix' } });
    const noFocus = item(7, { worktree, focus: null });

    expect(windowTabs(snapshot([blocked, other]), file, W)).toEqual({ focuses: [{ workItemId: 7, url: 'https://github.com/o/r/issues/107' }], reports: [] });
    expect(windowTabs(snapshot([noFocus]), file, W)).toEqual({ focuses: [], reports: [] });
  });
});

describe('workspace files', () => {
  const window = { name: 'gh-107-widgets', title: 'Fix ${x} badge for $5', folders: ['D:/git/widgets', 'D:/git/widgets/.worktrees/107-fix'], file: '' };

  it('lists the folders and ends the title with the window name, replacing each $ in the ticket title', () => {
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
        '    "window.titleSeparator": " · "',
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
