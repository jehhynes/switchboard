import type { HistoryTriage, Session, Ticket, TicketHistory } from '@switchboard/core';
import { describe, expect, it } from 'vitest';
import { durationText, historyMarkdown, timeText } from '../src/history.js';

const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const NOW = at(7, 14, 2);

const ticket: Ticket = { id: 3, source: 'github', sourceKey: '18941', ref: '#18941', sourceId: null, title: 'Inbox  badge\ncount', url: 'https://github.com/o/r/issues/18941', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' };

type HistoryItem = TicketHistory['workItems'][number];

function workItem(id: number, patch: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id,
    ticketId: 3,
    playbook: 'dev:review-pr',
    status: 'running',
    stage: null,
    stageAt: null,
    warning: null,
    error: null,
    failedStep: null,
    unassignedAt: null,
    queuedAt: null,
    approvalPrompt: null,
    approvalSummary: null,
    approvalReport: null,
    createdAt: at(1, 9),
    statusAt: at(1, 9),
    runStartedAt: null,
    scopeAt: null,
    doneAt: null,
    doneReason: null,
    parentId: null,
    sessions: [],
    triages: [],
    ...patch,
  };
}

function session(patch: Partial<Session>): Session {
  return { id: 's1', workItemId: 1, kind: 'task', provider: 'claude', nativeSessionId: null, shortId: null, cwd: 'D:/git/widgets', state: 'ended', stateAt: 0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: at(1, 9, 1), endedAt: null, released: false, reports: [], ...patch };
}

function triage(patch: Partial<HistoryTriage>): HistoryTriage {
  return { id: 1, ticketId: 3, workItemId: 1, playbook: null, immediacy: null, severity: null, model: null, startedAt: at(1, 9), endedAt: at(1, 9, 1), error: null, ...patch };
}

describe('historyMarkdown', () => {
  it('lists a returned ticket\'s work items newest first, with their triages, sessions, done reason and approval', () => {
    const history: TicketHistory = {
      ticket,
      workItems: [
        workItem(2, {
          status: 'awaiting-approval',
          createdAt: at(6, 10),
          approvalSummary: 'Post the\nreview comment',
          triages: [triage({ id: 2, workItemId: 2, playbook: 'dev:review-pr-followup', startedAt: at(6, 10) })],
          sessions: [session({ id: 's2', workItemId: 2, startedAt: at(6, 10, 2), endedAt: at(6, 12, 7), outcome: null, state: 'ended' })],
        }),
        workItem(1, {
          status: 'done',
          doneReason: 'session',
          doneAt: at(1, 11, 30),
          triages: [triage({ playbook: 'dev:review-pr' })],
          sessions: [session({ startedAt: at(1, 9, 1), endedAt: at(1, 9, 40), outcome: 'done' }), session({ id: 's3', kind: 'setup', startedAt: at(1, 8), endedAt: at(1, 8, 0) + 45_000, outcome: 'stopped', outcomeDetail: 'Stopped by you.' })],
        }),
      ],
      poolTriages: [],
    };

    expect(historyMarkdown(history, NOW)).toBe(
      [
        '# gh 18941 Inbox badge count',
        '',
        'https://github.com/o/r/issues/18941',
        '',
        'As of 2026-10-07 14:02.',
        '',
        '## dev:review-pr · awaiting-approval',
        '',
        '- Created 2026-10-06 10:00',
        '- Approval: Post the review comment',
        '',
        '### Triages',
        '',
        '- 2026-10-06 10:00: dev:review-pr-followup',
        '',
        '### Sessions',
        '',
        '- task, 2026-10-06 10:02 to 2026-10-06 12:07, 2h 5m: ended',
        '',
        '## dev:review-pr · done, finished by the session',
        '',
        '- Created 2026-10-01 09:00',
        '- Done 2026-10-01 11:30',
        '',
        '### Triages',
        '',
        '- 2026-10-01 09:00: dev:review-pr',
        '',
        '### Sessions',
        '',
        '- task, 2026-10-01 09:01 to 2026-10-01 09:40, 39m: done',
        '- setup, 2026-10-01 08:00 to 2026-10-01 08:00, 45s: stopped, Stopped by you.',
        '',
      ].join('\n'),
    );
  });

  it('shows a session with no end as running so far, a failed work item\'s error, and a failed and a running triage', () => {
    const history: TicketHistory = {
      ticket: { ...ticket, url: '' },
      workItems: [
        workItem(1, {
          status: 'failed',
          error: 'Classifier timed out.',
          triages: [triage({ error: 'Classifier\ntimed out.' }), triage({ id: 4, startedAt: at(7, 13), endedAt: null })],
          sessions: [session({ startedAt: at(4, 12, 2), endedAt: null, state: 'running' })],
        }),
      ],
      poolTriages: [],
    };

    expect(historyMarkdown(history, NOW).split('\n')).toEqual([
      '# gh 18941 Inbox badge count',
      '',
      'As of 2026-10-07 14:02.',
      '',
      '## dev:review-pr · failed',
      '',
      '- Created 2026-10-01 09:00',
      '- Error: Classifier timed out.',
      '',
      '### Triages',
      '',
      '- 2026-10-01 09:00: failed, Classifier timed out.',
      '- 2026-10-07 13:00: running',
      '',
      '### Sessions',
      '',
      '- task, 2026-10-04 12:02, not ended, 3d 2h so far: running',
      '',
    ]);
  });

  it('shows a ticket with no work items and its pool triages, and an ad-hoc work item without a playbook or sessions', () => {
    const pool: TicketHistory = {
      ticket: { ...ticket, source: 'zoho', sourceKey: '3301' },
      workItems: [],
      poolTriages: [triage({ workItemId: null, playbook: 'support:defect' }), triage({ id: 2, workItemId: null, startedAt: at(2, 9), endedAt: at(2, 9, 1) })],
    };

    expect(historyMarkdown(pool, NOW).split('\n').slice(4)).toEqual(['As of 2026-10-07 14:02.', '', 'No work items.', '', '## Pool triages', '', '- 2026-10-01 09:00: support:defect', '- 2026-10-02 09:00: no playbook', '']);
    expect(historyMarkdown(pool, NOW).split('\n')[0]).toBe('# zoho 3301 Inbox badge count');

    const adhoc: TicketHistory = { ticket: { ...ticket, source: 'adhoc', sourceKey: '4', url: '' }, workItems: [workItem(1, { playbook: null, status: 'done', doneReason: 'operator', doneAt: at(1, 10) })], poolTriages: [] };

    expect(historyMarkdown(adhoc, NOW).split('\n').slice(4)).toEqual(['## ad-hoc prompt · done, marked done', '', '- Created 2026-10-01 09:00', '- Done 2026-10-01 10:00', '', '### Sessions', '', 'None.', '']);

    const untriaged: TicketHistory = { ticket, workItems: [workItem(1, { playbook: null, status: 'triaging' })], poolTriages: [] };

    expect(historyMarkdown(untriaged, NOW)).toContain('\n## no playbook · triaging\n');
  });
});

describe('timeText and durationText', () => {
  it('formats local times and durations', () => {
    expect(timeText(at(7, 9, 5))).toBe('2026-10-07 09:05');
    expect(durationText(59_999)).toBe('59s');
    expect(durationText(60_000)).toBe('1m');
    expect(durationText(3_599_000)).toBe('59m');
    expect(durationText(3_600_000)).toBe('1h 0m');
    expect(durationText(86_400_000 + 3_600_000)).toBe('1d 1h');
    expect(durationText(-5)).toBe('0s');
  });
});
