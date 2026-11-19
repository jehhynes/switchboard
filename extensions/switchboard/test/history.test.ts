import { DEFAULT_SETTINGS, PERMISSION_PROMPT, Store, handle, parsePlaybook } from '@switchboard/core';
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
  sources: { github: { kind: 'github', pollIntervalSeconds: 300, repoRoot: 'D:/git/widgets', triagePlaybook: 'triage:github', setupPrompt: '', namespace: '', options: {} } },
};

function playbooks(): Map<string, Playbook> {
  const entries: Record<string, unknown> = {
    'triage:github': { description: 'Triage', kind: 'triage', template: 'Classify.' },
    'dev:question': { description: 'Answer a question', reports: ['approval'], template: 'Answer {{ticket.title}}.' },
  };

  return new Map(Object.entries(entries).map(([name, entry]) => [name, (parsePlaybook(name, entry) as { playbook: Playbook }).playbook]));
}

const ISSUE = { sourceKey: '77', ref: '#77', repo: '', sourceId: null, title: 'Inbox badge', url: 'https://github.com/o/r/issues/77', assigned: true, pool: false, sortAt: null, enteredAt: null };

/** Drives a real store through the flow, so the history is what the hub would return. */
class Run {
  readonly store = Store.open(':memory:');
  now = T0;
  #sessions = 0;

  send(event: FlowEvent): void {
    this.store.transaction(() => handle(this.store, event, { now: this.now, settings: SETTINGS, playbooks: playbooks(), report: 'report', newSessionId: () => `s${++this.#sessions}`, newUuid: () => 'uuid' }));
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
  it('explains handled registration and release without exposing assignment keys', () => {
    const run = new Run();
    run.send({ type: 'register', nativeSessionId: 'native', shortId: 'native', cwd: 'D:/repo', title: 'Prepare fix' });
    const event = { type: 'handled' as const, sessionId: 's1', source: 'github', sourceKey: '77', ref: '#77', repo: '', title: 'Fix', url: ISSUE.url, key: 'I:opaque-event-id', release: false, assigned: false };
    run.send(event);
    run.send({ ...event, release: true });
    const view = historyView(run.store.ticketHistory(2)!, run.now);
    const entries = view.sections.flatMap((section) => section.entries);
    expect(texts(entries)).toContain('Registered the assignment as already handled');
    expect(texts(entries)).toContain('Released the handled assignment');
    expect(JSON.stringify(entries)).not.toContain('opaque-event-id');
  });
  it('says a handled assignment ended with the reporting work item, not what ended that work item (PRD R85)', () => {
    const run = new Run();
    run.send({ type: 'register', nativeSessionId: 'native', shortId: 'native', cwd: 'D:/repo', title: 'Prepare fix' });
    run.send({ type: 'handled', sessionId: 's1', source: 'github', sourceKey: '77', ref: '#77', repo: '', title: 'Fix', url: ISSUE.url, key: 'I:A', release: false, assigned: false });
    run.send({ type: 'mark-done', workItemId: 1 });
    const entries = historyView(run.store.ticketHistory(2)!, run.now).sections.flatMap((section) => section.entries);
    expect(texts(entries)).toEqual(['Registered the assignment as already handled', 'Handled assignment ended: the work that handled it ended']);
  });
  it('words only the ticket entry as the release when the ended registration gives an assigned ticket a work item (PRD R85)', () => {
    const run = new Run();
    run.send({ type: 'register', nativeSessionId: 'native', shortId: 'native', cwd: 'D:/repo', title: 'Prepare fix' });
    run.send({ type: 'handled', sessionId: 's1', source: 'github', sourceKey: '77', ref: '#77', repo: '', title: 'Fix', url: ISSUE.url, key: 'I:A', release: false, assigned: true });
    run.send({ type: 'poll', source: 'github', tickets: [ISSUE] });
    run.send({ type: 'mark-done', workItemId: 1 });
    const sections = historyView(run.store.ticketHistory(2)!, run.now).sections;
    const ended = sections.flatMap((section) => section.entries).filter((entry) => entry.text === 'Handled assignment ended: the work that handled it ended');
    expect(ended).toHaveLength(1);
    expect(sections.find((section) => section.key === 'ticket')!.entries).toContain(ended[0]);
    expect(sections.filter((section) => section.key !== 'ticket').flatMap((section) => texts(section.entries))).not.toContain('Handled assignment ended: the work that handled it ended');
  });
  it('says when a schedule came due and when its open run kept it from making another (PRD R82)', () => {
    const store = Store.open(':memory:');
    const settings: Settings = { ...SETTINGS, schedules: { cleanup: { playbook: 'dev:question', repoRoot: 'D:/git/widgets', every: 'day', day: null, at: 10 * 60 } } };
    const tick = (now: number) => store.transaction(() => handle(store, { type: 'tick' }, { now, settings, playbooks: playbooks(), report: 'report', newSessionId: () => 's1', newUuid: () => 'uuid' }));

    tick(T0);
    tick(T0 + 61 * MINUTE);
    tick(T0 + 25 * 60 * MINUTE);

    const view = historyView(JSON.parse(JSON.stringify(store.ticketHistory(1))) as TicketHistory, T0 + 25 * 60 * MINUTE);

    expect(view.sections[0]!.title).toBe('dev:question');
    expect(texts(view.sections[0]!.entries)).toEqual([`The schedule came due at ${timeText(T0 + 60 * MINUTE)}`]);
    expect(texts(view.sections.at(-1)!.entries)).toEqual(['Switchboard first saw the ticket, assigned to you', `The schedule came due at ${timeText(T0 + 25 * 60 * MINUTE)}; it made no work item, because one is still open`]);
  });

  it("shows an ad-hoc work item's prompt, the edited one after Start with prompt…, and no prompt for a playbook's or a registered session (PRD R59, R77)", () => {
    const run = new Run();

    run.send({ type: 'adhoc', prompt: 'Fix the <badge>', repoRoot: 'D:/git/widgets' });
    expect(historyView(run.history(), run.now).sections[0]!.prompt).toBe('Fix the <badge>');

    run.send({ type: 'start', workItemId: 1, prompt: 'Fix the <badge>\nin the inbox' });
    const section = historyView(run.history(), run.now).sections[0]!;

    expect(section.prompt).toBe('Fix the <badge>\nin the inbox');
    expect(section.entries.at(-1)).toMatchObject({ text: 'You started it with an edited prompt', detail: 'Fix the <badge>\nin the inbox' });

    const root = document.createElement('div');
    root.innerHTML = renderHistory(historyView(run.history(), run.now), EMPTY_UI);
    expect(root.querySelector('.section .prompt .text')!.textContent).toBe('Fix the <badge>\nin the inbox');

    run.send({ type: 'register', nativeSessionId: 'native-9', shortId: 'feed1234', cwd: 'D:/git/widgets', title: 'My session' });
    expect(historyView(JSON.parse(JSON.stringify(run.store.ticketHistory(2))) as TicketHistory, run.now).sections[0]!.prompt).toBeNull();
    root.innerHTML = renderHistory(historyView(JSON.parse(JSON.stringify(run.store.ticketHistory(2))) as TicketHistory, run.now), EMPTY_UI);
    expect(root.querySelector('.prompt')).toBeNull();
    expect(historyView(approvedRun().history(), T0).sections[0]!.prompt).toBeNull();
  });

  it('titles an ad-hoc section by how the work item was made (PRD R6, R68, R81)', () => {
    const run = new Run();

    run.send({ type: 'adhoc', prompt: 'Fix the badge', repoRoot: 'D:/git/widgets' });
    run.send({ type: 'register', nativeSessionId: 'native-9', shortId: 'feed1234', cwd: 'D:/git/widgets', title: 'My session' });

    expect(historyView(run.history(), run.now).sections[0]!.title).toBe('Ad-hoc prompt');
    expect(historyView(JSON.parse(JSON.stringify(run.store.ticketHistory(2))) as TicketHistory, run.now).sections[0]!.title).toBe('Registered session');

    // A ticket report keeps the section's origin, and its entry hides the ticket's own field changes (PRD R83).
    run.send({ type: 'ticket', sessionId: 's1', source: 'github', sourceKey: '115', ref: '#115', repo: '', title: 'Snapshot wrapper', url: 'https://github.com/o/r/issues/115', playbook: null });
    const moved = historyView(JSON.parse(JSON.stringify(run.store.ticketHistory(2))) as TicketHistory, run.now).sections[0]!;

    expect(moved.title).toBe('Registered session');
    expect(moved.entries.at(-1)).toMatchObject({ text: 'Moved this work from adhoc 2 to gh 115', lines: [] });

    // A later work item of the ticket, here with no playbook loaded to triage it, is not the moved one.
    run.send({ type: 'mark-done', workItemId: 2 });
    run.send({ type: 'poll', source: 'github', tickets: [{ ...ISSUE, sourceKey: '115', ref: '#115', repo: '', url: 'https://github.com/o/r/issues/115' }] });
    const sections = historyView(JSON.parse(JSON.stringify(run.store.ticketHistory(2))) as TicketHistory, run.now).sections;

    expect(sections.map((section) => section.title)).toEqual(['No playbook yet', 'Registered session', 'Ticket']);
  });

  it("names each entry by the copy the session had then, and shows a fork waiting for the background process (PRD R78)", () => {
    const run = new Run();
    const fork = { sessionId: 's1', nativeSessionId: '9e8d7c6b-0000', shortId: '9e8d7c6b', state: 'running' as const, detail: null };

    run.send({ type: 'poll', source: 'github', tickets: [ISSUE] });
    run.send({ type: 'triage-succeeded', triageId: 1, context: 'ctx', playbook: 'dev:question', immediacy: null, severity: null, model: 'claude-sonnet-5' });
    run.send({ type: 'start', workItemId: 1 });
    run.send({ type: 'session-started', sessionId: 's1', nativeSessionId: 'native-1', shortId: 'abc12345' });
    run.now += MINUTE;
    run.send({ type: 'roster', sessions: [{ sessionId: 's1', state: 'idle', detail: null, interactive: false }], forks: [fork] });
    run.now += MINUTE;
    run.send({ type: 'stop-succeeded', sessionId: 's1', reason: 'release', shortId: 'abc12345' });
    run.now += MINUTE;
    run.send({ type: 'roster', sessions: [], forks: [fork] });
    run.now += MINUTE;
    run.send({ type: 'marker', sessionId: 's1', state: 'idle', detail: null });

    const entries = historyView(run.history(), run.now).sections[0]!.entries;

    expect(texts(entries)).toEqual([
      'Work item created: Triaging',
      'Triage chose dev:question',
      'You started it',
      'Session abc12345 started',
      'Session abc12345 finished its turn',
      'Switchboard released session abc12345 so it can resume in VS Code',
      'The session continues in fork 9e8d7c6b',
      'Session 9e8d7c6b finished its turn',
    ]);
    expect(entries[6]).toMatchObject({ detail: 'Session abc12345 is retired.', lines: ['session 9e8d7c6b: ended → running', 'Status: Blocked → Running'] });
    expect(entries[4]!.lines).toContain('Fork 9e8d7c6b waits for the background session to be released; Stop releases one waiting on a question');
  });

  it('says a triage waits for Start when nothing is newer than the earlier work item (PRD R80)', () => {
    const run = new Run();

    run.send({ type: 'poll', source: 'github', tickets: [ISSUE] });
    run.send({ type: 'triage-succeeded', triageId: 1, context: 'ctx', playbook: 'dev:question', immediacy: null, severity: null, model: 'claude-sonnet-5', stale: true });

    const entries = historyView(run.history(), run.now).sections[0]!.entries;

    expect(entries[1]!.lines.some((line) => line.startsWith('Error'))).toBe(false);
    expect(texts(entries)).toEqual([
      'Work item created: Triaging',
      'Triage chose dev:question; it waits for Start, because nothing is newer than the earlier work item',
    ]);
  });

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

  it('shows a deleted work item only as the delete in the Ticket section (PRD R76)', () => {
    const run = approvedRun();

    run.send({ type: 'delete', workItemId: 1 });

    const sections = historyView(run.history(), run.now).sections;

    expect(sections.map((section) => section.key)).toEqual(['ticket']);
    expect(sections[0]!.entries.at(-1)).toMatchObject({ text: 'You deleted a work item', icon: 'trash', category: 'you', lines: [], refused: null });
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

  it('marks reconstructed entries, and opens a session in Claude unless it runs in its background process', () => {
    const run = approvedRun();
    const history = run.history();
    const fact: HistoryEvent = { id: 0, at: T0 - MINUTE, type: 'reconstructed', actor: 'hub', ticketId: 1, workItemId: 1, sessionId: null, detail: { fact: 'stage', stage: 'old stage' }, refused: null, changes: [] };
    const view = historyView({ ...history, events: [fact, ...history.events] }, run.now);
    const session = history.workItems[0]!.sessions[0]!;

    expect(view.reconstructed).toBe(true);
    expect(view.sections[0]!.entries[0]).toMatchObject({ text: 'Stage: old stage', reconstructed: true, category: 'report' });
    expect(sessionOpen({ ...session, state: 'running' })).toBeNull();
    expect(sessionOpen({ ...session, state: 'idle', released: true })).toEqual({ type: 'open', sessionId: 'native-1', cwd: 'D:/git/widgets', provider: 'claude' });
    expect(sessionOpen({ ...session, state: 'ended', released: true })).toEqual({ type: 'open', sessionId: 'native-1', cwd: 'D:/git/widgets', provider: 'claude' });
    expect(sessionOpen({ ...session, state: 'ended', nativeSessionId: null })).toBeNull();
    // A registered session opens only once it has left the operator's window (PRD R81).
    expect(sessionOpen({ ...session, state: 'idle', released: true, external: true })).toBeNull();
    expect(sessionOpen({ ...session, state: 'ended', released: true, external: false })).toEqual({ type: 'open', sessionId: 'native-1', cwd: 'D:/git/widgets', provider: 'claude' });
    expect(sessionOpen({ ...session, state: 'idle', released: true, releasing: true })).toBeNull();
  });

  it('says a Code Mode session started in Code Mode, and opens it in its attach terminal by its Switchboard session ID in every state (PRD R59, R95)', () => {
    const run = new Run();

    run.send({ type: 'poll', source: 'github', tickets: [ISSUE] });
    run.send({ type: 'triage-succeeded', triageId: 1, context: 'ctx', playbook: 'dev:question', immediacy: null, severity: null, model: 'claude-sonnet-5' });
    run.send({ type: 'start', workItemId: 1 });
    run.store.updateSession('s1', { codeMode: true });
    run.send({ type: 'session-started', sessionId: 's1', nativeSessionId: 'native-1', shortId: 'abc12345' });
    run.now += MINUTE;
    run.send({ type: 'marker', sessionId: 's1', state: 'waiting', detail: 'Which branch?' });

    const history = run.history();
    const entries = historyView(history, run.now).sections[0]!.entries;
    const open = { type: 'open', sessionId: 's1', cwd: 'D:/git/widgets', provider: 'claude', codeMode: true };
    const link = { label: 'Open in terminal', icon: 'terminal', title: 'Attach to Code Mode session abc12345 in a terminal', open };
    const session = history.workItems[0]!.sessions[0]!;

    expect(entries.find((entry) => entry.text.startsWith('Session abc12345 started'))).toMatchObject({ text: 'Session abc12345 started in Code Mode', links: [link] });
    expect(entries.filter((entry) => entry.links.length > 0).map((entry) => entry.links)).toEqual([[link], [link]]);
    // A background session's start keeps its wording.
    expect(texts(historyView(approvedRun().history(), run.now).sections[0]!.entries)).toContain('Session abc12345 started');

    for (const state of ['starting', 'running', 'waiting', 'idle', 'ended'] as const) {
      expect(sessionOpen({ ...session, state, released: false })).toEqual(open);
    }
  });

  it("opens a Codex session in Codex, and names it by its thread ID's last 8 characters", () => {
    const history = approvedRun().history();
    const codex = { ...history, workItems: history.workItems.map((item) => ({ ...item, sessions: item.sessions.map((session) => ({ ...session, provider: 'codex' as const, shortId: '01a128b1-5384-7b62-a7be-64a4b4c611a9', state: 'ended' as const, released: true })) })) };
    const started = historyView(codex, T0).sections[0]!.entries.find((entry) => entry.links.length > 0 && entry.links[0]!.label.startsWith('Open in'))!;

    expect(started.links[0]).toMatchObject({ label: 'Open in Codex', title: 'Open session b4c611a9 in Codex', open: { type: 'open', provider: 'codex' } });
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
      [event('report', 'session', { kind: 'question', text: 'Which tree?', options: ['Oak', 'Birch'] }), { text: 'Asked: Which tree?', detail: 'Oak · Birch' }],
      [event('report', 'session', { kind: 'playbook', playbook: 'dev:review' }, [change('workItem', 'update', { playbook: ['dev:question', 'dev:review'] })]), { text: 'Handed the work to dev:review', lines: [] }],
      [event('report', 'session', { kind: 'paste', label: 'Reply', file: 'D:/r.md' }, [change('paste', 'update', { file: ['D:/a.md', 'D:/r.md'] })]), { text: 'Drafted Reply', lines: [] }],
      [event('report', 'session', { kind: 'task', childTicketId: 2, childRef: '#4', childTitle: 'Fix it' }), { text: 'Queued a follow-up: Fix it', detail: 'Ad-hoc #4' }],
      [event('report', 'session', { kind: 'task', childTicketId: 1, childRef: '#77', childTitle: 'Fix it' }), { text: 'A session queued this follow-up', detail: null }],
      [event('report', 'session', { kind: 'other' }), { text: 'Reported other' }],
      [
        event('ticket', 'session', { source: 'github', sourceKey: '115', playbook: 'dev:develop', adhocKey: '3' }, [change('ticket', 'update', { source: ['adhoc', 'github'], sourceKey: ['3', '115'], assigned: [true, false] }, { workItemId: null })]),
        { text: 'Moved this work from adhoc 3 to gh 115 as dev:develop', lines: [], category: 'report' },
      ],
      [event('ticket', 'session', { source: 'github', sourceKey: '115', playbook: null, adhocKey: '3' }), { text: 'Moved this work from adhoc 3 to gh 115' }],
      // A refused report or a retry for the ticket the work item already has moves nothing.
      [event('ticket', 'session', { source: 'github', sourceKey: '115', playbook: 'dev:develop' }), { text: 'Asked to move this work to gh 115 as dev:develop' }],
      [event('report', 'session', { kind: 'ticket', url: 'https://github.com/o/r/issues/115' }), { text: 'Asked to move this work to https://github.com/o/r/issues/115' }],
      [event('session-start-failed', 'hub', { message: 'Untrusted folder' }, [change('session', 'update', { state: ['starting', 'ended'], outcome: [null, 'failed'] }, { sessionId: 's1' }), change('workItem', 'update', { status: ['running', 'failed'], error: [null, 'Untrusted folder'] })]), { text: 'The session failed to start', detail: 'Untrusted folder', lines: ['Status: Running → Failed', 'Error: Untrusted folder'], tone: 'error' }],
      [event('stop-succeeded', 'hub', { reason: 'release' }, [change('session', 'update', { state: ['idle', 'ended'], released: [false, true] }, { sessionId: 's1' })]), { text: 'Switchboard released session abc12345 so it can resume in VS Code', lines: [] }],
      [event('stop-succeeded', 'hub', { reason: 'operator' }, [change('session', 'update', { outcome: [null, 'stopped'], outcomeDetail: [null, 'Stopped by you.'] }, { sessionId: 's1' })]), { text: 'Session abc12345 stopped', lines: ['Outcome: stopped, Stopped by you.'] }],
      [event('stop-succeeded', 'hub', { reason: 'open' }, [change('session', 'update', { state: ['waiting', 'ended'], outcome: [null, 'opened'] }, { sessionId: 's1' })]), { text: 'Session abc12345 stopped to open its question', lines: [] }],
      [event('stop-failed', 'hub', { reason: 'open', message: 'exit 1' }, [change('workItem', 'update', { error: [null, 'Stop failed: exit 1'] })]), { text: 'Stopping the session failed', detail: 'exit 1', lines: [], tone: 'error' }],
      [event('reply-failed', 'hub', { message: 'no such session' }, [change('workItem', 'update', { error: [null, 'Answer failed: no such session'] })]), { text: 'Sending your answer failed', detail: 'no such session', lines: [], tone: 'error', category: 'session' }],
      [event('answer', 'operator', { answer: 'Birch\n bark' }, [], null), { text: 'You answered: Birch bark', category: 'you', tone: 'accent' }],
      [event('open-question', 'operator', null, [], null), { text: 'You opened the question in its session', category: 'you' }],
      [event('background', 'operator', null, [], null), { text: 'You asked to continue the session in the background', category: 'you' }],
      [
        event('session-resumed', 'hub', { shortId: 'abc12345' }, [change('session', 'update', { released: [true, false], shortId: ['abc12345', 'abc12345'] }, { sessionId: 's1' })]),
        { text: 'Session abc12345 continues in the background', lines: [], category: 'session' },
      ],
      [
        event('resume-failed', 'hub', { message: 'Claude started a copy as 4df6b678.' }, [
          change('session', 'update', { state: ['running', 'ended'], outcome: [null, 'failed'], released: [true, true] }, { sessionId: 's1' }),
          change('workItem', 'update', { status: ['running', 'blocked'], error: [null, 'Continue in Background failed: Claude started a copy as 4df6b678.'] }),
        ]),
        { text: 'Continuing in the background failed', detail: 'Claude started a copy as 4df6b678.', lines: ['Status: Running → Blocked'], tone: 'error' },
      ],
      [
        event('held-resumed', 'hub', { launchId: 'launch-2' }, [change('session', 'update', { state: ['ended', 'idle'], released: [true, false], endedAt: [5, null] }, { sessionId: 's1' })]),
        { text: 'Session abc12345 resumed in the terminal holder', lines: [], category: 'session' },
      ],
      [event('move-cancelled', 'hub', null, []), { text: 'Session abc12345 stayed in its tab, whose process did not exit', lines: [], category: 'session' }],
      [event('start', 'operator', { guidance: 'Check the 2024 thread.' }, [], null), { text: 'You started it with guidance', detail: 'Check the 2024 thread.', category: 'you', tone: 'accent' }],
      [event('pick', 'operator', { guidance: 'Reply in Spanish.' }, [], null), { text: 'You picked it from the pool with guidance', detail: 'Reply in Spanish.', category: 'you' }],
      [event('start', 'operator', null, [], null), { text: 'You started it', detail: null, category: 'you' }],
      [event('start', 'operator', { playbook: 'dev:other' }, [change('workItem', 'update', { playbook: ['dev:question', 'dev:other'] })], null), { text: 'You started it as dev:other', lines: ['Playbook: dev:question → dev:other'], category: 'you' }],
      [event('pick', 'operator', { guidance: 'Reply in Spanish.', playbook: 'support:defect' }, [], null), { text: 'You picked it from the pool as support:defect with guidance', detail: 'Reply in Spanish.' }],
      [event('register', 'operator', { cwd: 'D:/git/widgets' }, [], null), { text: 'You registered the session', category: 'you' }],
      [event('triage-failed', 'triage', { triageId: 1, error: 'Timed out' }, [change('triage', 'update', { error: [null, 'Timed out'] })], null), { text: 'Triage failed', detail: 'Timed out', category: 'triage', tone: 'error' }],
      [event('triage-cancelled', 'hub', { triageId: 1 }, [change('triage', 'update', { error: [null, 'Cancelled.'] })], null), { text: 'Triage cancelled because the hub stopped', lines: [] }],
      [event('worktree-found', 'hub', { path: 'D:/wt/77', branch: '77-fix' }, [change('worktree', 'insert', { path: [null, 'D:/wt/77'] })], null), { text: 'Found the worktree D:/wt/77 (77-fix)', lines: [] }],
      [event('roster', 'hub', null, [change('session', 'update', { state: ['running', 'idle'] }, { sessionId: 's1' })]), { text: 'Session abc12345 finished its turn', stateChange: true }],
      [event('roster', 'hub', null, [change('session', 'update', { state: ['running', 'failed'], stateDetail: [null, 'overloaded'] }, { sessionId: 's1' })]), { text: "Session abc12345's turn failed", detail: 'overloaded', tone: 'error' }],
      [event('roster', 'hub', null, [change('session', 'update', { state: ['idle', 'ended'] }, { sessionId: 's1' })]), { text: 'Session abc12345 ended', stateChange: false }],
      [event('roster', 'hub', null, [change('session', 'update', { released: [false, true] }, { sessionId: 's1' })]), { text: 'Background process released', category: 'session' }],
      [
        event('roster', 'hub', null, [change('session', 'update', { nativeSessionId: ['0f1e2d3c-0000', '9e8d7c6b-0000'], shortId: ['0f1e2d3c', '9e8d7c6b'], state: ['ended', 'running'] }, { sessionId: 's1' })]),
        { text: 'The session continues in fork 9e8d7c6b', detail: 'Session 0f1e2d3c is retired.', lines: ['session abc12345: ended → running'], category: 'session', stateChange: false },
      ],
      [
        event('roster', 'hub', null, [change('session', 'update', { nativeSessionId: ['0f1e2d3c-0000', '9e8d7c6b-0000'], shortId: ['0f1e2d3c', '9e8d7c6b'] }, { sessionId: 's1' })]),
        { text: 'The session continues in fork 9e8d7c6b', lines: [], stateChange: false },
      ],
      [event('poll', 'source', { source: 'github' }, [change('workItem', 'update', { unassignedAt: [null, 5] })], null), { text: 'Left the assigned state while a session was active', category: 'ticket' }],
      [event('poll', 'source', { source: 'github' }, [change('workItem', 'update', { unassignedAt: [5, null], warning: [null, 'Odd'], stage: ['a', 'b'], approvalSummary: [null, 'Ship'], custom: [1, 2] })], null), { text: 'Assigned to you again', lines: ['Warning: Odd', 'Stage: b', 'Approval: Ship', 'custom: 1 → 2'] }],
      [event('pick', 'operator', null, [change('triage', 'update', { workItemId: [null, 1] }), change('triage', 'delete', {}, { workItemId: null })], null), { text: 'You picked it from the pool', lines: ['Pool triage attached to the work item', 'Pool triage discarded'] }],
      [event('tick', 'hub', null, [change('triage', 'insert', { startedAt: [null, 1] })], null), { text: 'Triage started', category: 'triage' }],
      [
        event('roster', 'hub', null, [
          change('session', 'update', { outcome: [null, 'done'] }, { sessionId: 's1' }),
          change('triage', 'update', { playbook: [null, 'dev:x'], error: [null, 'Bad'] }),
          change('worktree', 'update', { path: ['a', 'b'] }),
          change('link', 'update', { label: ['L1', 'L2'] }),
          change('paste', 'update', { file: ['a', 'b'] }),
          change('session', 'update', { state: ['running', 'waiting'], stateDetail: [null, 'Why?'] }, { sessionId: 's1' }),
        ]),
        { text: 'Session abc12345 is waiting for you', detail: 'Why?', lines: ['Outcome: done', 'Triage chose dev:x', 'Triage error: Bad', 'Worktree: b', 'Link renamed: L1 → L2', 'Draft replaced: b'] },
      ],
      [event('snooze', 'operator', { until: T0 + 24 * 60 * MINUTE }, [], null), { text: `You snoozed it until ${timeText(T0 + 24 * 60 * MINUTE)}`, category: 'you' }],
      [event('snooze', 'operator', { until: null }, [], null), { text: 'You snoozed it indefinitely' }],
      [event('snooze', 'operator', { until: null, comment: 'Waiting for the release.' }, [], null), { text: 'You snoozed it indefinitely', detail: 'Waiting for the release.', category: 'you', tone: 'accent' }],
      [event('comment', 'operator', { text: 'Waiting on Dana.\nAsk Monday.' }, [], null), { text: 'You commented', detail: 'Waiting on Dana.\nAsk Monday.', category: 'you', tone: 'accent' }],
      [event('restore', 'operator', null, [], null), { text: 'You restored it', lines: [] }],
      [event('stop', 'operator', null, [], null), { text: 'You asked to stop the session' }],
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

  it("words the ticket's open blockers: at first sight, as they change, and once none is open (PRD R90)", () => {
    const base = approvedRun().history();
    const fields = (value: HistoryChange['fields'], op: HistoryChange['op'] = 'update'): HistoryChange => ({ entity: 'ticket', entityId: '1', op, workItemId: null, sessionId: null, fields: value });
    const twelve = { url: 'https://github.com/o/r/issues/12', ref: '#12', title: 'A' };
    const docs = { url: 'https://github.com/o/docs/issues/7', ref: 'o/docs#7', title: 'B' };
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
      changes: [fields({ assigned: [null, true], blockers: [null, [twelve]] }, 'insert'), fields({ blockers: [[twelve], [twelve, docs]] }), fields({ blockers: [[twelve, docs], []] })],
    };
    const unblocked: HistoryEvent = { ...poll, id: 501, changes: [fields({ assigned: [null, true], blockers: [null, []] }, 'insert')] };

    expect(historyView({ ...base, workItems: [], events: [poll] }, T0).sections[0]!.entries[0]).toMatchObject({
      text: 'Switchboard first saw the ticket, assigned to you',
      lines: ['Blocker: #12', 'Blockers: #12, o/docs#7', 'No open blockers'],
    });
    expect(historyView({ ...base, workItems: [], events: [unblocked] }, T0).sections[0]!.entries[0]).toMatchObject({ text: 'Switchboard first saw the ticket, assigned to you', lines: [] });
  });

  it('shows a new question asked while the session was already waiting, with no session link while it runs in its background process', () => {
    const run = approvedRun();

    run.send({ type: 'marker', sessionId: 's1', state: 'waiting', detail: 'First question?' });
    run.send({ type: 'marker', sessionId: 's1', state: 'waiting', detail: 'Second question?' });

    const entries = historyView(run.history(), run.now).sections[0]!.entries.slice(-2);

    expect(entries.map((entry) => [entry.text, entry.detail, entry.tone])).toEqual([
      ['Session abc12345 is waiting for you', 'First question?', 'warning'],
      ['Session abc12345 is waiting for you', 'Second question?', 'warning'],
    ]);
    expect(entries[1]!.links).toEqual([]);
  });

  it('names a permission prompt in words, not by its state detail (PRD R70)', () => {
    const run = approvedRun();

    run.send({ type: 'marker', sessionId: 's1', state: 'waiting', detail: PERMISSION_PROMPT });

    const entry = historyView(run.history(), run.now).sections[0]!.entries.at(-1)!;

    expect([entry.text, entry.detail, entry.icon, entry.tone]).toEqual(['Session abc12345 is waiting on a permission prompt', null, 'shield', 'warning']);
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

it('labels retained Support queue and work facts in History', () => {
  const run = new Run();
  run.send({ type: 'poll', source: 'zoho', tickets: [{ ...ISSUE, assigned: false, inQueue: true, assigneeId: 'other' }] });
  run.store.volumeWorked(1, 'removed-session', T0 + 1);
  run.now += MINUTE;
  run.send({ type: 'poll', source: 'zoho', tickets: [] });
  const view = historyView(run.history(), run.now);
  const entries = view.sections.flatMap(section => section.entries);
  expect(entries.some(entry => entry.text === 'Worked in Switchboard')).toBe(true);
  expect(JSON.stringify(entries)).toContain('Observed outside the active Support queue');
  expect(JSON.stringify(entries)).not.toContain('ticket.inQueue');
  expect(JSON.stringify(entries)).not.toContain('volume-worked');
  run.store.close();
});
