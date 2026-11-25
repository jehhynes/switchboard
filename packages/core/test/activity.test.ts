import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordRefusal } from '../src/flow.js';
import { MIGRATIONS, Store } from '../src/store.js';
import type { HistoryEvent } from '../src/store.js';
import { Harness, MINUTE, T0, issue, settings } from './flowHarness.js';

/** The ticket's logged events as `type/actor`. */
function types(events: HistoryEvent[]): string[] {
  return events.map((event) => `${event.type}/${event.actor}`);
}

function history(h: Harness, ticketId = 1) {
  return h.store.ticketHistory(ticketId)!;
}

/** A started dev:question task session for ticket 1, which awaits approval. */
function running(h: Harness): string {
  const [triage] = h.poll(issue('1'));
  h.triaged(triage, 'dev:question');
  h.now += MINUTE;

  return h.started(h.act({ type: 'start', workItemId: 1 })[0]);
}

describe('activity log', () => {
  it('logs each step of a run with its actor, and the rows each step changed', () => {
    const h = new Harness();
    const sessionId = running(h);

    h.now += MINUTE;
    h.report(sessionId, { kind: 'stage', stage: 'researching' });
    h.report(sessionId, { kind: 'stage', stage: 'researching' });
    h.act({ type: 'marker', sessionId, state: 'waiting', detail: 'Which branch?' });
    h.act({ type: 'marker', sessionId, state: 'running', detail: null });
    h.report(sessionId, { kind: 'approval', prompt: 'Publish it', summary: 'Post the answer', report: 'D:/draft.md' });
    h.now += MINUTE;
    h.act({ type: 'approve', workItemId: 1 });

    const { events } = history(h);

    expect(types(events)).toEqual([
      'poll/source',
      'triage-succeeded/triage',
      'start/operator',
      'session-started/hub',
      'report/session',
      // A repeated stage changes no row, but the report is still logged.
      'report/session',
      'marker/hub',
      'marker/hub',
      'report/session',
      'approve/operator',
    ]);
    expect(events[0]!.changes.map((change) => `${change.entity}:${change.op}`)).toEqual(['ticket:insert', 'workItem:insert', 'triage:insert']);
    expect(events[1]).toMatchObject({ workItemId: 1, detail: { triageId: 1, playbook: 'dev:question', model: 'claude-sonnet-5' } });
    // The triage context and task prompt are logged as changed, not by their text.
    expect(events[1]!.changes.find((change) => change.entity === 'triage')!.fields['context']).toEqual([null, true]);
    expect(events[2]).toMatchObject({ at: T0 + MINUTE, ticketId: 1, workItemId: 1 });
    expect(events[2]!.changes.map((change) => `${change.entity}:${Object.keys(change.fields).join(',')}`)).toEqual([
      'workItem:status',
      'workItem:taskPrompt',
      'session:workItemId,kind,provider,nativeSessionId,cwd,state,startedAt,released,reports',
      'workItem:status',
    ]);
    expect(events[2]!.changes.find((change) => change.entity === 'workItem' && 'taskPrompt' in change.fields)!.fields['taskPrompt']).toEqual([null, true]);
    // A stage sets a state, which the activity log leaves to the report itself.
    expect(events[4]).toMatchObject({ detail: { kind: 'stage', stage: 'researching' }, changes: [] });
    expect(events[5]).toMatchObject({ detail: { kind: 'stage', stage: 'researching' }, changes: [] });
    expect(events[6]!.changes).toEqual([
      { entity: 'session', entityId: sessionId, op: 'update', workItemId: 1, sessionId, fields: { state: ['running', 'waiting'], stateDetail: [null, 'Which branch?'] } },
    ]);
    // The approval prompt is left out of the report's detail.
    expect(events[8]!.detail).toEqual({ kind: 'approval', summary: 'Post the answer', report: 'D:/draft.md' });
    expect(events[8]!.changes[0]!.fields).toMatchObject({ status: ['running', 'awaiting-approval'], approvalPrompt: [null, true], approvalSummary: [null, 'Post the answer'] });
  });

  it('logs nothing for a poll or roster read that changes no logged field', () => {
    const h = new Harness();
    const sessionId = running(h);
    const before = history(h).revision;

    h.now += MINUTE;
    h.poll(issue('1'));
    h.act({ type: 'roster', sessions: [{ sessionId, state: 'running', detail: null }] });
    h.act({ type: 'tick' });

    expect(history(h).revision).toBe(before);
  });

  it('logs a poll that changes the title, and a snooze that wakes, as their own events', () => {
    const h = new Harness();
    h.poll(issue('1'));
    h.act({ type: 'snooze', ticketId: 1, until: T0 + 10 * MINUTE });
    h.now += 20 * MINUTE;
    h.poll({ ...issue('1'), title: 'Renamed' });

    const events = history(h).events.slice(-3);

    expect(types(events)).toEqual(['snooze/operator', 'wake/hub', 'poll/source']);
    expect(events[0]).toMatchObject({ detail: { until: T0 + 10 * MINUTE } });
    expect(events[1]!.changes[0]!.fields).toEqual({ snoozed: [true, false], snoozedUntil: [T0 + 10 * MINUTE, null] });
    expect(events[2]!.changes[0]!.fields).toEqual({ title: ['Issue 1', 'Renamed'] });
  });

  it('logs a refused operator action with its reason, and stores no refusal that names no ticket', () => {
    const h = new Harness();
    h.poll(issue('1'));

    expect(h.send({ type: 'approve', workItemId: 1 }).refused).toBe('The work item is not awaiting approval.');
    expect(h.send({ type: 'approve', workItemId: 99 }).refused).toBe('Unknown work item 99.');

    const events = history(h).events;

    expect(events.at(-1)).toMatchObject({ type: 'approve', actor: 'operator', workItemId: 1, refused: 'The work item is not awaiting approval.', changes: [] });
    expect(events.filter((event) => event.refused !== null)).toHaveLength(1);
  });

  it('logs a refusal the hub made before the flow saw the event', () => {
    const h = new Harness();
    const sessionId = running(h);

    h.store.transaction(() => recordRefusal(h.store, { type: 'report', sessionId, report: { kind: 'worktree', path: 'D:/nope', branch: null } }, T0 + HOUR_LATER, 'D:/nope is not a git worktree.'));

    expect(history(h).events.at(-1)).toMatchObject({ type: 'report', actor: 'session', sessionId, at: T0 + HOUR_LATER, detail: { kind: 'worktree', path: 'D:/nope' }, refused: 'D:/nope is not a git worktree.' });
  });

  it('logs a link and a paste reported again as an update only when a value changed', () => {
    const h = new Harness();
    const sessionId = running(h);

    h.report(sessionId, { kind: 'link', label: 'PR', target: 'https://github.com/o/r/pull/2' });
    h.now += MINUTE;
    h.report(sessionId, { kind: 'link', label: 'PR', target: 'https://github.com/o/r/pull/2' });
    h.report(sessionId, { kind: 'link', label: 'Pull request', target: 'https://github.com/o/r/pull/2' });
    h.act({ type: 'worktree-found', source: 'github', sourceKey: '1', path: 'D:/wt/1', branch: '1-fix' });

    const events = history(h).events.slice(-4);

    expect(events.map((event) => event.changes.map((change) => `${change.entity}:${change.op}`))).toEqual([['link:insert'], [], ['link:update'], ['worktree:insert']]);
    expect(events[2]!.changes[0]!.fields).toEqual({ label: ['PR', 'Pull request'] });
    expect(events[3]).toMatchObject({ type: 'worktree-found', actor: 'hub', ticketId: 1, detail: { path: 'D:/wt/1', branch: '1-fix' } });
  });

  it("logs a task report on the reporting ticket with the follow-up's ticket, and the follow-up's rows on its own ticket", () => {
    const h = new Harness();
    const sessionId = running(h);

    h.report(sessionId, { kind: 'task', prompt: 'Fix the flaky test\nIn store.test.ts', repo: null, title: null });

    const parent = history(h).events.at(-1)!;
    const child = history(h, 2).events;

    expect(parent).toMatchObject({ type: 'report', ticketId: 1, detail: { kind: 'task', repo: null, title: null, childTicketId: 2, childRef: '#1', childTitle: 'Fix the flaky test' }, changes: [] });
    expect(parent.detail).not.toHaveProperty('prompt');
    expect(child.map((event) => event.id)).toEqual([parent.id]);
    expect(child[0]!.changes.map((change) => `${change.entity}:${change.op}`)).toEqual(['ticket:insert', 'workItem:insert']);
  });

  it('removes the activity of a work item deleted when its ticket leaves, including its pool triage, and changes the revision (PRD R10)', () => {
    // No session slot, so the picked work item stays queued without a session.
    const h = new Harness({ settings: settings({ sessions: { concurrency: 0 } }) });
    h.poll({ ...issue('1', false), pool: true });
    const [triage] = h.store.runningTriages();
    h.act({ type: 'triage-succeeded', triageId: triage!.id, context: 'c', playbook: 'dev:question', immediacy: null, severity: null, model: null });
    h.act({ type: 'pick', ticketId: 1 });
    // The claim makes the ticket assigned; it then leaves before a session starts.
    h.poll(issue('1'));
    const before = history(h).revision;

    h.poll();

    const after = history(h);

    expect(after.revision).not.toBe(before);
    expect(after.workItems).toEqual([]);
    expect(after.events.flatMap((event) => event.changes.map((change) => change.entity))).toEqual(['ticket', 'ticket', 'ticket']);
    // The pick names only the ticket, so the operator's request stays though the work item it made is gone.
    expect(types(after.events)).toEqual(['poll/source', 'pick/operator', 'poll/source', 'poll/source']);
  });

  it('advances the revision when a work item whose ticket left during triage is deleted after it, though no event is added for the ticket', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.poll();
    const before = history(h).revision;

    h.triaged(triage, 'dev:question');

    expect(h.store.workItem(1)).toBeNull();
    expect(history(h).revision).not.toBe(before);
    expect(history(h).events.flatMap((event) => event.changes.map((change) => change.entity))).toEqual(['ticket', 'ticket']);
  });

  it('records when the log began, and reconstructs the facts older rows still hold on migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchboard-activity-'));

    try {
      const path = join(dir, 'old.db');
      const raw = new DatabaseSync(path);
      const log = MIGRATIONS.findIndex((migration) => migration.includes('CREATE TABLE events'));
      raw.exec(MIGRATIONS.slice(0, log).join(';'));
      raw.exec(`PRAGMA user_version = ${log}`);
      raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (1, 'github', '1', 'One', 'u', 0, '')");
      raw.exec("INSERT INTO workItems (id, ticketId, playbook, status, stage, stageAt, createdAt, statusAt, doneAt, doneReason) VALUES (1, 1, 'dev:develop', 'done', 'testing', 30, 10, 50, 50, 'session')");
      raw.exec("INSERT INTO triages (id, ticketId, workItemId, playbook, startedAt, endedAt) VALUES (1, 1, 1, 'dev:develop', 11, 12)");
      raw.exec("INSERT INTO sessions (id, workItemId, kind, provider, cwd, state, stateAt, outcome, startedAt, endedAt, released) VALUES ('s1', 1, 'task', 'claude', 'D:/', 'ended', 45, 'done', 20, 45, 1)");
      raw.exec("INSERT INTO links (ticketId, label, target, reportedAt) VALUES (1, 'PR', 'https://x/pull/1', 40)");
      raw.close();

      const store = Store.open(path);
      const events = store.ticketHistory(1)!.events;

      expect(events.map((event) => [event.at, event.type, event.detail!['fact']])).toEqual([
        [10, 'reconstructed', 'created'],
        [11, 'reconstructed', 'triageStarted'],
        [12, 'reconstructed', 'triageEnded'],
        [20, 'reconstructed', 'sessionStarted'],
        [30, 'reconstructed', 'stage'],
        [40, 'reconstructed', 'link'],
        [45, 'reconstructed', 'sessionEnded'],
        [50, 'reconstructed', 'done'],
      ]);
      expect(events[6]).toMatchObject({ sessionId: 's1', workItemId: 1, detail: { kind: 'task', outcome: 'done' } });
      // The session's state at migration, so a later change of its question alone keeps it.
      expect(events[3]).toMatchObject({ sessionId: 's1', detail: { fact: 'sessionStarted', kind: 'task', state: 'ended' } });
      expect(store.recordedSince()).toBeGreaterThan(T0 - 365 * 24 * 60 * MINUTE);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const HOUR_LATER = 60 * MINUTE;
