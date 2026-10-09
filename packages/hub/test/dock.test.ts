import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockView, windowOf, windowsDir, workspaceText, writeWorkspaceFile } from '../src/dock.js';
import type { DockRow } from '../src/dock.js';
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

  it('lists the panel groups in panel order, with Snoozed only when it has rows', () => {
    const view = dockView(snapshot([item(1, { status: 'blocked' }), item(2), item(3, { status: 'unstarted' })], { pool: [pool(4)] }), NOW, W);

    expect(view.groups.map((group) => [group.key, group.title, group.empty, group.rows.map((entry) => entry.key)])).toEqual([
      ['needs', 'Needs you', 'Nothing needs you.', ['item:1']],
      ['working', 'Working', 'Nothing is running.', ['item:2']],
      ['unstarted', 'Unstarted', 'Nothing waits to be started.', ['item:3', 'ticket:4']],
      ['done', 'Done', null, []],
    ]);
    expect(dockView(snapshot([item(5, { ticket: { ...item(5).ticket, snoozed: true } })]), NOW, W).groups.at(-1)?.rows.map((entry) => entry.key)).toEqual(['item:5']);
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

  it('gives a row its main control, answers, pastes, VS Code commands and search text', () => {
    const waiting = row(
      item(7, {
        worktree,
        sessions: [session({ state: 'waiting' })],
        question: { text: 'Which fruit?', options: [{ label: 'Apple', description: 'red' }, { label: 'Plum', description: '' }], parts: 1 },
        links: [{ id: 1, ticketId: 7, label: 'PR', target: 'https://github.com/o/r/pull/19002', reportedAt: NOW }],
      }),
    );

    expect(waiting.main).toBe('Open in Claude');
    expect(waiting.mainTitle).toBe('Open in Claude');
    expect(waiting.answers).toEqual([
      { label: 'Apple', description: 'red', action: { type: 'answer', workItemId: 7, nativeSessionId: 'aaaa1111-native', question: 'Which fruit?', answer: 'Apple' } },
      { label: 'Plum', description: '', action: { type: 'answer', workItemId: 7, nativeSessionId: 'aaaa1111-native', question: 'Which fruit?', answer: 'Plum' } },
    ]);
    expect(waiting.commands).toEqual([
      { label: 'Open Changes', command: { type: 'changes', path: 'D:/git/widgets/.worktrees/107-fix', key: 'gh 107', title: 'Issue <7>' } },
      { label: 'History', command: { type: 'history', ticketId: 7, key: 'gh 107' } },
    ]);
    expect(waiting.search).toBe('Issue <7> · gh 107 · PR #19002 · dev:develop · Needs you · 107-fix');
    expect(row(item(7, { sessions: [session({ state: 'waiting' })], question: { text: 'Two parts', options: [{ label: 'A', description: '' }], parts: 2 } })).answers).toEqual([]);

    const approval = row(item(7, { status: 'awaiting-approval', approvalReport: 'D:/drafts/reply.md', pastes: [{ id: 1, workItemId: 7, label: 'Reply', file: 'D:/r.md', reportedAt: NOW }] }));

    expect(approval.main).toBe('Approve');
    expect(approval.mainTitle).toBe('Approve');
    expect(row(item(7, { status: 'awaiting-approval', approvalPrompt: '/review-pr pr:123 publish' })).mainTitle).toBe('Approve: runs /review-pr pr:123 publish');
    expect(approval.pastes).toEqual([{ label: 'Reply', file: 'D:/r.md' }]);
    expect(approval.commands).toEqual([
      { label: 'History', command: { type: 'history', ticketId: 7, key: 'gh 107' } },
      { label: 'Open report', command: { type: 'openUrl', url: 'D:/drafts/reply.md' } },
    ]);
    expect(row(item(7, { status: 'blocked', pastes: [{ id: 1, workItemId: 7, label: 'Reply', file: 'D:/r.md', reportedAt: NOW }] })).pastes).toEqual([]);
    expect(row(item(7)).main).toBeNull();
    expect(row(item(7)).mainTitle).toBeNull();
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
    expect(triaging!.controls).toEqual([{ label: 'Snooze', action: { type: 'snooze', ticketId: 4 } }]);
    expect(triaging!.main).toBeNull();
    expect(triaging!.commands).toEqual([{ label: 'History', command: { type: 'history', ticketId: 4, key: 'gh 104' } }]);
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
      { label: 'PR #19002', url: 'https://github.com/o/r/pull/19002' },
      { label: 'gh 18941', url: 'https://github.com/o/r/issues/18941' },
      { label: 'Design doc', url: 'https://example.test/doc' },
    ]);
    expect(shown.returned).toBe(3);
  });

  it('matches the recorded dock message the dock app reads', () => {
    const recorded = JSON.parse(readFileSync(new URL('../../../apps/dock/test/fixtures/dock.json', import.meta.url), 'utf8')) as unknown;
    const view = dockView(
      snapshot(
        [
          item(7, {
            status: 'blocked',
            error: 'The session finished its turn.',
            worktree,
            sessions: [session({ state: 'ended', cwd: worktree.path })],
            links: [{ id: 1, ticketId: 7, label: 'Pull request', target: 'https://github.com/o/r/pull/19002', reportedAt: NOW }],
            returned: 2,
          }),
          item(8, { sessions: [session({ state: 'waiting', cwd: 'D:/git/widgets' })], question: { text: 'Which branch?', options: [{ label: 'main', description: 'The default branch' }], parts: 1 } }),
          item(9, { status: 'unstarted', triage: triage({ immediacy: 'BLOCKING', severity: 'MED' }) }),
          item(10, {
            status: 'awaiting-approval',
            approvalPrompt: '/support-release #4521',
            approvalSummary: 'post the reply',
            approvalReport: 'D:/drafts/reply.md',
            pastes: [{ id: 1, workItemId: 10, label: 'Customer reply', file: 'D:/drafts/reply.md', reportedAt: NOW }],
            sessions: [session({ state: 'ended', cwd: 'D:/git/support' })],
          }),
        ],
        { pool: [pool(4)], sourceStates: [{ name: 'github', enabled: true }, { name: 'zoho', enabled: false }] },
      ),
      NOW,
      W,
    );

    expect(view).toEqual(recorded);
  });
});

describe('windowOf', () => {
  it('opens the latest session folder first, with the worktree second when the session ran elsewhere', () => {
    expect(windowOf(item(7, { worktree, sessions: [session({ cwd: 'D:\\git\\widgets\\.worktrees\\107-fix\\' })] }), W)).toEqual({
      name: 'gh-107-58c609',
      title: 'sb:gh-107-58c609 · Issue <7>',
      folders: ['D:\\git\\widgets\\.worktrees\\107-fix\\'],
      file: `${W}\\gh-107-58c609.code-workspace`,
    });
    expect(windowOf(item(7, { worktree, sessions: [session({ cwd: 'D:/git/widgets' })] }), W)).toEqual({
      name: 'gh-107-widgets-655280',
      title: 'sb:gh-107-widgets-655280 · Issue <7>',
      folders: ['D:/git/widgets', 'D:/git/widgets/.worktrees/107-fix'],
      file: `${W}\\gh-107-widgets-655280.code-workspace`,
    });
    expect(windowOf(item(7, { worktree }), W)).toEqual({
      name: 'gh-107-58c609',
      title: 'sb:gh-107-58c609 · Issue <7>',
      folders: ['D:/git/widgets/.worktrees/107-fix'],
      file: `${W}\\gh-107-58c609.code-workspace`,
    });
    expect(windowOf(item(7, { sessions: [session({ cwd: 'D:/git/support' })], ticket: { ...item(7).ticket, source: 'zoho', sourceKey: '4521/a b' } }), W)).toEqual({
      name: 'zoho-4521-a-b-support-c6262c',
      title: 'sb:zoho-4521-a-b-support-c6262c · Issue <7>',
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

describe('workspace files', () => {
  const window = { name: 'gh-107-widgets', title: 'sb:gh-107-widgets · Fix ${x} badge', folders: ['D:/git/widgets', 'D:/git/widgets/.worktrees/107-fix'], file: '' };

  it('lists the folders and starts the title with the prefix, breaking a ${ in the ticket title', () => {
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
        '    "window.title": "sb:gh-107-widgets · Fix $ {x} badge · ${activeEditorShort}"',
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

    writeWorkspaceFile({ ...window, file, title: 'sb:gh-107-widgets · Renamed' }, written);
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
