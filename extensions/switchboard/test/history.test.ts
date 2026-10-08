import { DEFAULT_SETTINGS, Store, handle, parsePlaybook } from '@switchboard/core';
import type { FlowEvent, HistoryChange, HistoryEvent, Playbook, Settings, TicketHistory } from '@switchboard/core';
import { describe, expect, it, vi } from 'vitest';
import { startHistory } from '../src/webview/historyMain.js';
import { durationText, historyView, sessionOpen, timeText } from '../src/webview/historyModel.js';
import type { Entry } from '../src/webview/historyModel.js';
import { EMPTY_UI, RUN_LIMIT, renderHistory, shown } from '../src/webview/historyRender.js';

const T0 = new Date(2026, 9, 7, 9, 0, 0).getTime();
const MINUTE = 60_000;

const SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  sources: { github: { enabled: true, pollIntervalSeconds: 300, repoRoot: 'D:/git/widgets', triagePlaybook: 'triage', setupPrompt: '', namespace: '', options: {} } },
};

function playbooks(): Map<string, Playbook> {
  const texts: Record<string, string> = {
    triage: '---\ndescription: Triage\nkind: triage\n---\nClassify.',
    'dev:question': '---\ndescription: Answer a question\nreports: approval\n---\nAnswer {{ticket.title}}.',
  };

  return new Map(Object.entries(texts).map(([name, text]) => [name, (parsePlaybook(name, text) as { playbook: Playbook }).playbook]));
}

const ISSUE = { sourceKey: '77', ref: '#77', sourceId: null, title: 'Inbox badge', url: 'https://github.com/o/r/issues/77', assigned: true, pool: false, sortAt: null, enteredAt: null };

/** Drives a real store through the flow, so the history is what the hub would return. */
class Run {
  readonly store = Store.open(':memory:');
  now = T0;
  #sessions = 0;

  send(event: FlowEvent): void {
    this.store.transaction(() => handle(this.store, event, { now: this.now, settings: SETTINGS, playbooks: playbooks(), report: 'report', newSessionId: () => `s${++this.#sessions}` }));
  }

  history(): TicketHistory {
    // The hub sends the history as JSON.
    return JSON.parse(JSON.stringify(this.store.ticketHistory(1))) as TicketHistory;
  }
}

/** Ticket gh 77 through triage, a started session with a stage and a question, and an approval request that the operator approves. */
function approvedRun(): Run {
  const run = new Run();

  run.send({ type: 'poll', source: 'github', tickets: [ISSUE] });
  run.now += MINUTE;
  run.send({ type: 'triage-succeeded', triageId: 1, context: 'ctx', playbook: 'dev:question', immediacy: null, severity: null, model: 'claude-sonnet-5' });
  run.now += 2 * MINUTE;
  run.send({ type: 'start', workItemId: 1 });
  run.send({ type: 'session-started', sessionId: 's1', nativeSessionId: 'native-1', shortId: 'abc12345' });
  run.now += MINUTE;
  run.send({ type: 'report', sessionId: 's1', report: { kind: 'stage', stage: 'researching' } });
  run.send({ type: 'marker', sessionId: 's1', state: 'waiting', detail: 'Which branch?' });
  run.now += 10 * MINUTE;
  run.send({ type: 'marker', sessionId: 's1', state: 'running', detail: null });
  run.send({ type: 'report', sessionId: 's1', report: { kind: 'approval', prompt: '/publish', summary: 'Post the answer', report: 'D:/draft.md' } });
  run.now += 2 * 60 * MINUTE;
  run.send({ type: 'approve', workItemId: 1 });

  return run;
}

function texts(entries: Entry[]): string[] {
  return entries.map((entry) => entry.text);
}

describe('History model', () => {
  it('turns a run into a work item section of plain entries, with the ticket in its own section', () => {
    const run = approvedRun();
    const view = historyView(run.history(), run.now);
    const [item, ticket] = view.sections;

    expect(view).toMatchObject({ key: 'gh 77', title: 'Inbox badge', reconstructed: false });
    expect(view.facts).toEqual([
      { label: 'Status', value: 'Queued' },
      { label: 'Work items', value: '1' },
      { label: 'Sessions', value: '1, 2h 11m' },
      { label: 'Waited on you (logged)', value: '2h 12m' },
      { label: 'In scope since', value: timeText(T0) },
    ]);
    expect(view.links.map((link) => link.label)).toEqual(['Open ticket']);
    expect(item).toMatchObject({ title: 'dev:question', status: 'Queued', facts: [`Created ${timeText(T0)}`, '1 session, 2h 11m', 'Waited on you 2h 12m (logged)'] });
    expect(texts(item!.entries)).toEqual([
      'Work item created: Triaging',
      'Triage chose dev:question',
      'You started it',
      'Session abc12345 started',
      'Stage: researching',
      'Session abc12345 is waiting for you',
      'Session abc12345 is working',
      'Asked for approval: Post the answer',
      'You approved it',
    ]);
    expect(item!.entries.map((entry) => entry.category)).toEqual(['ticket', 'triage', 'you', 'session', 'report', 'session', 'session', 'report', 'you']);
    expect(item!.entries[0]!.lines).toEqual(['Triage started']);
    expect(item!.entries[1]).toMatchObject({ detail: 'Model: claude-sonnet-5', lines: ['Status: Triaging → Unstarted'] });
    expect(item!.entries[2]).toMatchObject({ tone: 'accent', lines: ['Status: Unstarted → Queued', 'Task prompt written', 'Task session starting in D:/git/widgets', 'Status: Queued → Running'] });
    expect(item!.entries[5]).toMatchObject({ detail: 'Which branch?', tone: 'warning', shortId: 'abc12345', stateChange: true, lines: [] });
    expect(item!.entries[7]).toMatchObject({ tone: 'accent', lines: ['Status: Running → Awaiting approval'] });
    expect(item!.entries[7]!.links.map((link) => [link.label, link.open])).toEqual([['Draft', { type: 'openUrl', url: 'D:/draft.md' }]]);
    expect(ticket).toMatchObject({ key: 'ticket', title: 'Ticket' });
    expect(texts(ticket!.entries)).toEqual(['Switchboard first saw the ticket, assigned to you']);
  });

  it('shows a refusal, a snooze and its end, a reported link and a failed stop with their words and tones', () => {
    const run = approvedRun();

    run.send({ type: 'approve', workItemId: 1 });
    run.send({ type: 'snooze', ticketId: 1, until: run.now + 5 * MINUTE });
    run.now += 10 * MINUTE;
    run.send({ type: 'tick' });
    run.send({ type: 'stop-failed', sessionId: 's1', reason: 'operator', message: 'claude stop exited 1' });
    run.send({ type: 'report', sessionId: 's1', report: { kind: 'link', label: 'PR 12', target: 'https://github.com/o/r/pull/12' } });

    const [item, ticket] = historyView(run.history(), run.now).sections;
    const refused = item!.entries.find((entry) => entry.refused !== null)!;

    expect(refused).toMatchObject({ text: 'You approved it', refused: 'The work item is not awaiting approval.', tone: 'error' });
    expect(texts(ticket!.entries).slice(-2)).toEqual([`You snoozed it until ${timeText(T0 + 139 * MINUTE)}`, 'Snooze ended']);
    expect(item!.entries.at(-2)).toMatchObject({ text: 'Stopping the session failed', detail: 'claude stop exited 1', tone: 'error', lines: [] });
    expect(item!.entries.at(-1)!.links).toEqual([{ label: 'PR 12', icon: 'link-external', title: 'https://github.com/o/r/pull/12', open: { type: 'openUrl', url: 'https://github.com/o/r/pull/12' } }]);
  });

  it('marks reconstructed entries, and opens a session by attaching to its background process or resuming it', () => {
    const run = approvedRun();
    const history = run.history();
    const fact: HistoryEvent = { id: 0, at: T0 - MINUTE, type: 'reconstructed', actor: 'hub', ticketId: 1, workItemId: 1, sessionId: null, detail: { fact: 'stage', stage: 'old stage' }, refused: null, changes: [] };
    const view = historyView({ ...history, events: [fact, ...history.events] }, run.now);
    const session = history.workItems[0]!.sessions[0]!;

    expect(view.reconstructed).toBe(true);
    expect(view.sections[0]!.entries[0]).toMatchObject({ text: 'Stage: old stage', reconstructed: true, category: 'report' });
    expect(sessionOpen({ ...session, state: 'running' }, 'github 77')).toEqual({ type: 'attach', shortId: 'abc12345', name: 'github 77' });
    expect(sessionOpen({ ...session, state: 'idle', released: true }, 'github 77')).toEqual({ type: 'resume', sessionId: 'native-1', cwd: 'D:/git/widgets', name: 'github 77', active: true });
    expect(sessionOpen({ ...session, state: 'ended', released: true }, 'github 77')).toMatchObject({ type: 'resume', active: false });
    expect(sessionOpen({ ...session, state: 'ended', nativeSessionId: null }, 'github 77')).toBeNull();
  });

  it('words every event, report and reconstructed fact, and every logged field', () => {
    const base = approvedRun().history();
    let id = 100;
    const change = (entity: HistoryChange['entity'], op: HistoryChange['op'], fields: HistoryChange['fields'], patch: Partial<HistoryChange> = {}): HistoryChange => ({ entity, entityId: '1', op, workItemId: 1, sessionId: null, fields, ...patch });
    const event = (type: string, actor: HistoryEvent['actor'], detail: Record<string, unknown> | null, changes: HistoryChange[] = [], sessionId: string | null = 's1'): HistoryEvent => ({ id: ++id, at: T0, type, actor, ticketId: 1, workItemId: 1, sessionId, detail, refused: null, changes });
    const cases: [HistoryEvent, Partial<Entry>][] = [
      [event('report', 'session', { kind: 'worktree', path: 'D:/wt/77' }, [change('worktree', 'insert', { path: [null, 'D:/wt/77'] }, { workItemId: null })]), { text: 'Reported the worktree D:/wt/77', lines: [] }],
      [event('report', 'session', { kind: 'done', assigned: true }), { text: 'Reported done, but the ticket is still assigned to you', tone: 'warning' }],
      [event('report', 'session', { kind: 'done' }, [change('workItem', 'update', { status: ['running', 'done'], doneReason: [null, 'session'] })]), { text: 'Reported done', lines: ['Done: finished by the session'], tone: 'success' }],
      [event('report', 'session', { kind: 'playbook', playbook: 'dev:review' }, [change('workItem', 'update', { playbook: ['dev:question', 'dev:review'] })]), { text: 'Handed the work to dev:review', lines: [] }],
      [event('report', 'session', { kind: 'paste', label: 'Reply', file: 'D:/r.md' }, [change('paste', 'update', { file: ['D:/a.md', 'D:/r.md'] })]), { text: 'Drafted Reply', lines: [] }],
      [event('report', 'session', { kind: 'task', childTicketId: 2, childRef: '#4', childTitle: 'Fix it' }), { text: 'Queued a follow-up: Fix it', detail: 'Ad-hoc #4' }],
      [event('report', 'session', { kind: 'task', childTicketId: 1, childRef: '#77', childTitle: 'Fix it' }), { text: 'A session queued this follow-up', detail: null }],
      [event('report', 'session', { kind: 'other' }), { text: 'Reported other' }],
      [event('session-start-failed', 'hub', { message: 'Untrusted folder' }, [change('session', 'update', { state: ['starting', 'ended'], outcome: [null, 'failed'] }, { sessionId: 's1' }), change('workItem', 'update', { status: ['running', 'failed'], error: [null, 'Untrusted folder'] })]), { text: 'The session failed to start', detail: 'Untrusted folder', lines: ['Status: Running → Failed', 'Error: Untrusted folder'], tone: 'error' }],
      [event('stop-succeeded', 'hub', { reason: 'release' }, [change('session', 'update', { state: ['idle', 'ended'], released: [false, true] }, { sessionId: 's1' })]), { text: 'Switchboard released session abc12345 so it can resume in VS Code', lines: [] }],
      [event('stop-succeeded', 'hub', { reason: 'operator' }, [change('session', 'update', { outcome: [null, 'stopped'], outcomeDetail: [null, 'Stopped by you.'] }, { sessionId: 's1' })]), { text: 'Session abc12345 stopped', lines: ['Outcome: stopped, Stopped by you.'] }],
      [event('triage-failed', 'triage', { triageId: 1, error: 'Timed out' }, [change('triage', 'update', { error: [null, 'Timed out'] })], null), { text: 'Triage failed', detail: 'Timed out', category: 'triage', tone: 'error' }],
      [event('triage-cancelled', 'hub', { triageId: 1 }, [change('triage', 'update', { error: [null, 'Cancelled.'] })], null), { text: 'Triage cancelled because the hub stopped', lines: [] }],
      [event('worktree-found', 'hub', { path: 'D:/wt/77', branch: '77-fix' }, [change('worktree', 'insert', { path: [null, 'D:/wt/77'] })], null), { text: 'Found the worktree D:/wt/77 (77-fix)', lines: [] }],
      [event('roster', 'hub', null, [change('session', 'update', { state: ['running', 'idle'] }, { sessionId: 's1' })]), { text: 'Session abc12345 finished its turn', stateChange: true }],
      [event('roster', 'hub', null, [change('session', 'update', { state: ['running', 'failed'], stateDetail: [null, 'overloaded'] }, { sessionId: 's1' })]), { text: "Session abc12345's turn failed", detail: 'overloaded', tone: 'error' }],
      [event('roster', 'hub', null, [change('session', 'update', { state: ['idle', 'ended'] }, { sessionId: 's1' })]), { text: 'Session abc12345 ended', stateChange: false }],
      [event('roster', 'hub', null, [change('session', 'update', { released: [false, true] }, { sessionId: 's1' })]), { text: 'Background process released', category: 'session' }],
      [event('poll', 'source', { source: 'github' }, [change('workItem', 'update', { unassignedAt: [null, 5] })], null), { text: 'Left the assigned state while a session was active', category: 'ticket' }],
      [event('poll', 'source', { source: 'github' }, [change('workItem', 'update', { unassignedAt: [5, null], warning: [null, 'Odd'], stage: ['a', 'b'], approvalSummary: [null, 'Ship'], custom: [1, 2] })], null), { text: 'Assigned to you again', lines: ['Warning: Odd', 'Stage: b', 'Approval: Ship', 'custom: 1 → 2'] }],
      [event('pick', 'operator', null, [change('triage', 'update', { workItemId: [null, 1] }), change('triage', 'delete', {}, { workItemId: null })], null), { text: 'You picked it from the pool', lines: ['Pool triage attached to the work item', 'Pool triage discarded'] }],
      [event('tick', 'hub', null, [change('triage', 'insert', { startedAt: [null, 1] })], null), { text: 'Triage started', category: 'triage' }],
      [event('reconstructed', 'hub', { fact: 'created', playbook: 'dev:question' }), { text: 'Work item created: dev:question', reconstructed: true }],
      [event('reconstructed', 'hub', { fact: 'triageStarted' }), { text: 'Triage started' }],
      [event('reconstructed', 'hub', { fact: 'triageEnded', playbook: 'dev:question' }), { text: 'Triage chose dev:question' }],
      [event('reconstructed', 'hub', { fact: 'triageEnded', error: 'Boom' }), { text: 'Triage failed', detail: 'Boom', tone: 'error' }],
      [event('reconstructed', 'hub', { fact: 'sessionStarted', kind: 'setup' }), { text: 'Setup session abc12345 started' }],
      [event('reconstructed', 'hub', { fact: 'sessionEnded', outcome: 'failed', outcomeDetail: 'Crashed' }), { text: 'Session abc12345 ended: failed', detail: 'Crashed', tone: 'error' }],
      [event('reconstructed', 'hub', { fact: 'status', status: 'awaiting-approval', approvalSummary: 'Ship', approvalReport: 'D:/d.md' }), { text: 'Asked for approval: Ship', tone: 'accent' }],
      [event('reconstructed', 'hub', { fact: 'status', status: 'blocked', error: 'Stopped' }), { text: 'Blocked', detail: 'Stopped', tone: 'warning' }],
      [event('reconstructed', 'hub', { fact: 'done', reason: 'operator' }), { text: 'Done: marked done', tone: 'success' }],
      [event('reconstructed', 'hub', { fact: 'link', label: 'PR', target: 'https://x/pull/1' }), { text: 'Linked PR' }],
      [event('reconstructed', 'hub', { fact: 'paste', label: 'Reply', file: 'D:/r.md' }), { text: 'Drafted Reply' }],
      [event('reconstructed', 'hub', { fact: 'mystery' }), { text: 'mystery' }],
    ];

    for (const [logged, expected] of cases) {
      const entries = historyView({ ...base, events: [logged] }, T0).sections[0]!.entries;

      expect(entries[0], JSON.stringify(logged.detail ?? logged.changes)).toMatchObject(expected);
    }
  });

  it('words the ticket section: first sight, assignment, the pool, a title change and snoozes', () => {
    const base = approvedRun().history();
    const fields = (value: HistoryChange['fields'], op: HistoryChange['op'] = 'update'): HistoryChange => ({ entity: 'ticket', entityId: '1', op, workItemId: null, sessionId: null, fields: value });
    const poll: HistoryEvent = {
      id: 500,
      at: T0,
      type: 'poll',
      actor: 'source',
      ticketId: null,
      workItemId: null,
      sessionId: null,
      detail: { source: 'github' },
      refused: null,
      changes: [fields({ pool: [null, true] }, 'insert'), fields({ assigned: [true, false], pool: [false, true], title: ['A', 'B'] }), fields({ snoozed: [false, true], snoozedUntil: [null, null] }), fields({ snoozed: [true, false] }), fields({ pool: [true, false] })],
    };
    const ticket = historyView({ ...base, workItems: [], events: [poll] }, T0).sections[0]!;

    expect(ticket.key).toBe('ticket');
    expect(ticket.entries[0]).toMatchObject({ text: 'Switchboard first saw the ticket, in the pool', lines: ['No longer assigned to you', 'Entered the pool', 'Title: A → B', 'Snoozed indefinitely', 'Snooze ended', 'Left the pool'] });
  });

  it('shows a new question asked while the session was already waiting, with its session link', () => {
    const run = approvedRun();

    run.send({ type: 'marker', sessionId: 's1', state: 'waiting', detail: 'First question?' });
    run.send({ type: 'marker', sessionId: 's1', state: 'waiting', detail: 'Second question?' });

    const entries = historyView(run.history(), run.now).sections[0]!.entries.slice(-2);

    expect(entries.map((entry) => [entry.text, entry.detail, entry.tone])).toEqual([
      ['Session abc12345 is waiting for you', 'First question?', 'warning'],
      ['Session abc12345 is waiting for you', 'Second question?', 'warning'],
    ]);
    expect(entries[1]!.links.map((link) => link.label)).toEqual(['Attach']);
  });

  it('keeps the waiting state of a session from before the log began when only its question changes', () => {
    const base = approvedRun().history();
    const started: HistoryEvent = { id: 1, at: T0, type: 'reconstructed', actor: 'hub', ticketId: 1, workItemId: 1, sessionId: 's1', detail: { fact: 'sessionStarted', kind: 'task', state: 'waiting' }, refused: null, changes: [] };
    const asked: HistoryEvent = {
      id: 2,
      at: T0 + MINUTE,
      type: 'roster',
      actor: 'hub',
      ticketId: null,
      workItemId: null,
      sessionId: null,
      detail: null,
      refused: null,
      changes: [{ entity: 'session', entityId: 's1', op: 'update', workItemId: 1, sessionId: 's1', fields: { stateDetail: ['Old?', 'New?'] } }],
    };
    const entries = historyView({ ...base, events: [started, asked] }, T0).sections[0]!.entries;

    expect(entries[1]).toMatchObject({ text: 'Session abc12345 is waiting for you', detail: 'New?', tone: 'warning' });
    expect(entries[1]!.links).toHaveLength(1);
  });

  it("words work another work item's event caused from its own changes, without that event's headline or refusal", () => {
    const base = approvedRun().history();
    const other: HistoryEvent = {
      id: 900,
      at: T0,
      type: 'stop-succeeded',
      actor: 'hub',
      ticketId: 2,
      workItemId: 2,
      sessionId: 's9',
      detail: { reason: 'release' },
      refused: null,
      changes: [
        { entity: 'workItem', entityId: '1', op: 'update', workItemId: 1, sessionId: null, fields: { status: ['queued', 'running'] } },
        { entity: 'session', entityId: 's5', op: 'insert', workItemId: 1, sessionId: 's5', fields: { kind: [null, 'task'], cwd: [null, 'D:/git/widgets'], state: [null, 'starting'] } },
      ],
    };
    const [entry] = historyView({ ...base, events: [other] }, T0).sections[0]!.entries;

    expect(entry).toMatchObject({ text: 'Status: Queued → Running', lines: ['Task session starting in D:/git/widgets'], category: 'session', refused: null });

    // An action on another ticket, such as restoring it, that starts this one from the queue is not credited to this ticket.
    const restored = historyView({ ...base, events: [{ ...other, type: 'restore', actor: 'operator', workItemId: null, sessionId: null, detail: null }] }, T0).sections[0]!.entries[0];

    expect(restored).toMatchObject({ text: 'Status: Queued → Running', category: 'session' });
  });

  it('formats times and durations', () => {
    expect(timeText(new Date(2026, 9, 7, 9, 5).getTime())).toBe('2026-10-07 09:05');
    expect(durationText(59_999)).toBe('59s');
    expect(durationText(3_600_000)).toBe('1h 0m');
    expect(durationText(86_400_000 + 3_600_000)).toBe('1d 1h');
    expect(durationText(-5)).toBe('0s');
  });
});

describe('History page', () => {
  it('renders the header, chips with counts, day headings, gaps and the newest section open', () => {
    const run = approvedRun();
    const root = document.createElement('div');

    root.innerHTML = renderHistory(historyView(run.history(), run.now), EMPTY_UI);

    expect(root.querySelector('h1')?.textContent).toBe('Inbox badge');
    expect([...root.querySelectorAll('.chip')].map((chip) => chip.textContent)).toEqual(['You2', 'Sessions3', 'Reports2', 'Triage1', 'Ticket2']);
    expect([...root.querySelectorAll<HTMLDetailsElement>('details.section')].map((section) => section.open)).toEqual([true, false]);
    expect(root.querySelectorAll('.day')).toHaveLength(2);
    expect([...root.querySelectorAll('.entry .gap')].map((gap) => gap.textContent).filter(Boolean)).toEqual(['+1m', '+2m', '+1m', '+10m', '+2h 0m']);
    expect(root.querySelector('.entry.tone-warning .detail')?.textContent).toBe('Which branch?');
    expect(root.querySelector('.banner')).toBeNull();
  });

  it('filters by chip and by text, counting what the filter hides, and collapses a long run of state changes', () => {
    const run = approvedRun();
    const view = historyView(run.history(), run.now);
    const root = document.createElement('div');

    root.innerHTML = renderHistory(view, { ...EMPTY_UI, hidden: ['session', 'ticket', 'triage'], query: '' });
    expect([...root.querySelectorAll('[data-section="w1"] .entry .text')].map((text) => text.textContent)).toEqual(['You started itabc12345', 'Stage: researchingabc12345', 'Asked for approval: Post the answerabc12345', 'You approved it']);
    expect(root.querySelector('[data-section="w1"] .count')?.textContent).toBe('4 of 9');

    root.innerHTML = renderHistory(view, { ...EMPTY_UI, query: 'BRANCH' });
    expect(root.querySelectorAll('[data-section="w1"] .entry')).toHaveLength(1);
    expect(root.querySelector('[data-section="ticket"] .empty')?.textContent).toBe('No entries match the filter.');

    const states = Array.from({ length: RUN_LIMIT + 1 }, (_, index): Entry => ({ ...view.sections[0]!.entries[5]!, key: `r${index}`, at: T0 + index * 1000 }));
    const long = { ...view, sections: [{ ...view.sections[0]!, entries: states }] };

    root.innerHTML = renderHistory(long, EMPTY_UI);
    expect(root.querySelector('.run summary')?.textContent).toContain(`${RUN_LIMIT + 1} session state changes`);
    expect(root.querySelector<HTMLDetailsElement>('.run details')?.open).toBe(false);

    root.innerHTML = renderHistory({ ...long, sections: [{ ...long.sections[0]!, entries: states.slice(0, RUN_LIMIT) }] }, EMPTY_UI);
    expect(root.querySelector('.run')).toBeNull();
    expect(shown(states[0]!, { ...EMPTY_UI, query: 'abc1' })).toBe(true);
  });

  it('says when logging began when it shows reconstructed entries', () => {
    const run = approvedRun();
    const view = { ...historyView(run.history(), run.now), reconstructed: true, recordedSince: T0 };
    const root = document.createElement('div');

    root.innerHTML = renderHistory(view, EMPTY_UI);

    expect(root.querySelector('.banner')?.textContent).toContain(`Switchboard began logging on ${timeText(T0)}.`);
  });

  it('asks for the history, renders it, keeps the chips, search and sections in its state, and posts what to open', () => {
    const run = approvedRun();
    const posted: unknown[] = [];
    let state: unknown = null;
    const api = { postMessage: (message: unknown) => posted.push(message), getState: () => state, setState: (next: unknown) => (state = next) };
    const root = document.createElement('div');

    document.body.append(root);
    (window as { switchboardHistory?: unknown }).switchboardHistory = { ticketId: 1, key: 'gh 77' };
    vi.useFakeTimers();

    try {
      startHistory(root, api, () => run.now);

      expect(posted).toEqual([{ type: 'ready' }]);
      expect(state).toMatchObject({ ticketId: 1, key: 'gh 77' });

      window.dispatchEvent(new MessageEvent('message', { data: { type: 'history', history: run.history() } }));
      expect(root.querySelectorAll('[data-section="w1"] .entry')).toHaveLength(9);
      // The page says which revision it rendered, after rendering it.
      expect(posted.at(-1)).toEqual({ type: 'shown', revision: run.history().revision });

      root.querySelector<HTMLElement>('[data-category="you"]')!.click();
      expect(root.querySelectorAll('[data-section="w1"] .entry')).toHaveLength(7);
      expect(state).toMatchObject({ ticketId: 1, ui: { hidden: ['you'] } });

      const search = root.querySelector<HTMLInputElement>('#search')!;
      search.value = 'stage';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      expect(root.querySelectorAll('[data-section="w1"] .entry')).toHaveLength(1);
      expect(state).toMatchObject({ ui: { query: 'stage' } });

      root.querySelector<HTMLElement>('[data-all="open"]')!.click();
      expect(state).toMatchObject({ ui: { sections: { w1: true, ticket: true } } });

      // Closing a section by hand is kept, so the next redraw leaves it closed.
      const section = root.querySelector<HTMLDetailsElement>('[data-section="w1"]')!;
      section.open = false;
      section.dispatchEvent(new Event('toggle'));
      expect(state).toMatchObject({ ui: { sections: { w1: false, ticket: true } } });
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'history', history: run.history() } }));
      expect(root.querySelector<HTMLDetailsElement>('[data-section="w1"]')!.open).toBe(false);

      root.querySelector<HTMLElement>('[data-category="you"]')!.click();
      search.value = '';
      root.querySelector<HTMLInputElement>('#search')!.value = '';
      root.querySelector<HTMLInputElement>('#search')!.dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector<HTMLElement>('[data-open]')!.click();
      expect(posted.at(-1)).toEqual({ type: 'open', action: { type: 'openUrl', url: 'https://github.com/o/r/issues/77' } });

      window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'Switchboard: the hub did not answer.' } }));
      expect(root.querySelector('.error')?.textContent).toBe('Switchboard: the hub did not answer.');
    } finally {
      vi.useRealTimers();
      root.remove();
      delete (window as { switchboardHistory?: unknown }).switchboardHistory;
    }
  });

  it('starts from the filters a reloaded page saved', () => {
    const run = approvedRun();
    const api = { postMessage: () => {}, getState: () => ({ ticketId: 1, key: 'gh 77', ui: { ...EMPTY_UI, hidden: ['you', 'session'] } }), setState: () => {} };
    const root = document.createElement('div');

    vi.useFakeTimers();

    try {
      startHistory(root, api, () => run.now);
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'history', history: run.history() } }));

      expect([...root.querySelectorAll('.chip.on')].map((chip) => (chip as HTMLElement).dataset['category'])).toEqual(['report', 'triage', 'ticket']);
    } finally {
      vi.useRealTimers();
    }
  });
});
