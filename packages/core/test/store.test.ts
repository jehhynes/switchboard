import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, Store } from '../src/store.js';

describe('Store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switchboard-store-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a new file to the current version, in WAL mode, and reopens it without migrating again', () => {
    const path = join(dir, 'switchboard.db');
    const store = Store.open(path);

    store.insertTicket({ source: 'github', sourceKey: '1', ref: '#1', sourceId: null, title: 'One', url: 'u', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: 5, repoRoot: '' });
    store.close();

    const raw = new DatabaseSync(path);
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    raw.close();

    const reopened = Store.open(path);
    expect(reopened.findTicket('github', '1')).toEqual({ id: 1, source: 'github', sourceKey: '1', ref: '#1', sourceId: null, title: 'One', url: 'u', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: 5, repoRoot: '' });
    reopened.close();
  });

  it('moves a version 1 database to the current schema, keeping each triage with its ticket, unrated and without its summary', () => {
    const path = join(dir, 'v1.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS[0]!);
    raw.exec('PRAGMA user_version = 1');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (7, 'github', '1', 'One', 'u', 1, '')");
    raw.exec("INSERT INTO workItems (id, ticketId, status, queuedAt, createdAt) VALUES (3, 7, 'awaiting-approval', NULL, 1)");
    raw.exec("INSERT INTO triages (id, workItemId, summary, startedAt, endedAt) VALUES (5, 3, 'A summary.', 1, 2)");
    raw.close();

    const store = Store.open(path);

    expect(store.ticket(7)).toMatchObject({ pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null });
    expect(store.ticket(7)).not.toHaveProperty('iceboxed');
    // A work item waiting to be started is unstarted from migration 4 on (PRD R34).
    expect(store.workItem(3)).toMatchObject({ status: 'unstarted', approvalPrompt: null, approvalSummary: null });
    expect(store.workItem(3)).not.toHaveProperty('needsPick');
    expect(store.triagesFor(3)).toEqual([{ id: 5, ticketId: 7, workItemId: 3, context: null, playbook: null, immediacy: null, severity: null, model: null, startedAt: 1, endedAt: 2, error: null }]);
    store.close();
  });

  it('moves a version 6 iceboxed ticket to an indefinite snooze, lists only timed snoozes that are due, and lists the snoozes in force', () => {
    const path = join(dir, 'v6.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS.slice(0, 6).join(';'));
    raw.exec('PRAGMA user_version = 6');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, pool, iceboxed, repoRoot) VALUES (7, 'zoho', '1', 'Cold', 'u', 0, 1, 1, ''), (8, 'zoho', '2', 'Warm', 'u', 0, 1, 0, '')");
    raw.close();

    const store = Store.open(path);

    expect(store.ticket(7)).toMatchObject({ snoozed: true, snoozedUntil: null });
    expect(store.ticket(8)).toMatchObject({ snoozed: false, snoozedUntil: null });
    expect(store.dueSnoozes(Number.MAX_SAFE_INTEGER)).toEqual([]);

    store.updateTicket(8, { snoozed: true, snoozedUntil: 100 });
    expect(store.dueSnoozes(99)).toEqual([]);
    expect(store.dueSnoozes(100).map((ticket) => ticket.id)).toEqual([8]);
    expect(store.snoozedTickets(99).map((ticket) => ticket.id)).toEqual([7, 8]);
    expect(store.snoozedTickets(100).map((ticket) => ticket.id)).toEqual([7]);
    store.close();
  });

  it('ends a version 10 snooze on a ticket out of the source scope, and keeps one on an assigned or pool ticket', () => {
    const path = join(dir, 'v10.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS.slice(0, 10).join(';'));
    raw.exec('PRAGMA user_version = 10');
    raw.exec(
      "INSERT INTO tickets (id, source, sourceKey, title, url, assigned, pool, snoozed, snoozedUntil, repoRoot) VALUES (1, 'github', '1', 'a', 'u', 1, 0, 1, 50, ''), (2, 'zoho', '2', 'b', 'u', 0, 1, 1, NULL, ''), (3, 'github', '3', 'c', 'u', 0, 0, 1, 50, '')",
    );
    raw.close();

    const store = Store.open(path);

    expect([1, 2, 3].map((id) => [store.ticket(id)?.snoozed, store.ticket(id)?.snoozedUntil])).toEqual([
      [true, 50],
      [true, null],
      [false, null],
    ]);
    store.close();
  });

  it('blocks a version 11 work item waiting on a pick session, keeping its error, points it at Triage again, and drops needsPick and failedStep', () => {
    const path = join(dir, 'v11.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS.slice(0, 11).join(';'));
    raw.exec('PRAGMA user_version = 11');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, pool, repoRoot) VALUES (1, 'zoho', '1', 'a', 'u', 0, 1, '')");
    raw.exec(
      "INSERT INTO workItems (id, ticketId, playbook, status, failedStep, error, createdAt, statusAt, needsPick) VALUES (1, 1, 'support:case', 'blocked', 'pick', 'Stopped by you.', 1, 7, 1), (2, 1, 'support:case', 'setup', NULL, NULL, 1, 8, 1), (3, 1, 'support:case', 'done', NULL, NULL, 1, 9, 1), (4, 1, 'support:case', 'running', NULL, NULL, 1, 9, 0)",
    );
    raw.close();

    const store = Store.open(path);

    expect([1, 2, 3, 4].map((id) => store.workItem(id))).toMatchObject([
      { status: 'blocked', error: 'Stopped by you.' },
      { status: 'blocked', error: 'Pick sessions were removed. Triage again triages the ticket, and its task claims it.' },
      { status: 'done' },
      { status: 'running' },
    ]);
    expect(store.workItem(1)).not.toHaveProperty('needsPick');
    expect(store.workItem(1)).not.toHaveProperty('failedStep');
    store.close();
  });

  it('moves a version 3 work item waiting to be started to unstarted, and keeps one with an approval report', () => {
    const path = join(dir, 'v3.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS.slice(0, 3).join(';'));
    raw.exec('PRAGMA user_version = 3');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (1, 'github', '1', 'One', 'u', 1, '')");
    raw.exec("INSERT INTO workItems (id, ticketId, status, createdAt) VALUES (1, 1, 'awaiting-approval', 1), (2, 1, 'awaiting-approval', 1), (3, 1, 'running', 1)");
    raw.exec("UPDATE workItems SET approvalPrompt = '/publish' WHERE id = 2");
    raw.close();

    const store = Store.open(path);

    expect([1, 2, 3].map((id) => store.workItem(id)?.status)).toEqual(['unstarted', 'awaiting-approval', 'running']);
    store.close();
  });

  it('gives a version 4 ad-hoc ticket its #n reference and leaves polled ones for the next poll', () => {
    const path = join(dir, 'v4.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS.slice(0, 4).join(';'));
    raw.exec('PRAGMA user_version = 4');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (1, 'adhoc', '3', 'a', '', 1, ''), (2, 'forum', '34295', 't', 'u', 0, '')");
    raw.close();

    const store = Store.open(path);

    expect([store.ticket(1)?.ref, store.ticket(2)?.ref]).toEqual(['#3', '']);
    store.close();
  });

  it('estimates version 5 in-queue times from the times already stored', () => {
    const path = join(dir, 'v5.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS.slice(0, 5).join(';'));
    raw.exec('PRAGMA user_version = 5');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (1, 'adhoc', '1', 'a', '', 1, ''), (2, 'github', '2', 'b', 'u', 1, '')");
    raw.exec(
      "INSERT INTO workItems (id, ticketId, status, queuedAt, createdAt, doneAt) VALUES (1, 1, 'running', NULL, 10, NULL), (2, 2, 'blocked', NULL, 20, NULL), (3, 2, 'done', NULL, 5, 9), (4, 2, 'queued', 40, 30, NULL)",
    );
    raw.exec(
      "INSERT INTO sessions (id, workItemId, kind, provider, cwd, state, stateAt, startedAt, endedAt, released) VALUES ('a', 1, 'task', 'claude', '', 'running', 12, 12, NULL, 0), ('b', 2, 'task', 'claude', '', 'ended', 25, 21, 25, 1), ('c', 4, 'task', 'claude', '', 'ended', 35, 31, 35, 1)",
    );
    raw.close();

    const store = Store.open(path);

    // An ad-hoc ticket entered scope with its first work item; a polled ticket waits for the next poll. A done item counts from its creation,
    // and a queued retry from its queue time, not from its earlier session.
    expect([store.ticket(1)?.scopeAt, store.ticket(2)?.scopeAt]).toEqual([10, null]);
    expect([1, 2, 3, 4].map((id) => [store.workItem(id)?.statusAt, store.workItem(id)?.runStartedAt, store.workItem(id)?.scopeAt])).toEqual([
      [12, 12, null],
      [25, 21, null],
      [9, 5, 5],
      [40, 40, null],
    ]);
    store.close();
  });

  it('gives a version 7 approval its newest linked file as its report, and drops every local-file link', () => {
    const path = join(dir, 'v7.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS.slice(0, 7).join(';'));
    raw.exec('PRAGMA user_version = 7');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (1, 'github', '1', 'a', 'u', 1, ''), (2, 'github', '2', 'b', 'u', 1, '')");
    raw.exec("INSERT INTO workItems (id, ticketId, status, createdAt, approvalPrompt) VALUES (1, 1, 'awaiting-approval', 1, '/publish'), (2, 2, 'running', 1, NULL)");
    raw.exec(
      "INSERT INTO links (ticketId, label, target, reportedAt) VALUES (1, 'Old', 'D:\\wt\\round-1.md', 1), (1, 'New', 'D:\\wt\\round-2.md', 2), (1, 'PR', 'https://github.com/o/r/pull/3', 3), (2, 'Decisions', 'D:\\wt\\decisions.md', 1)",
    );
    raw.close();

    const store = Store.open(path);

    expect([store.workItem(1)?.approvalReport, store.workItem(2)?.approvalReport]).toEqual(['D:\\wt\\round-2.md', null]);
    expect([...store.linksFor(1), ...store.linksFor(2)].map((link) => link.target)).toEqual(['https://github.com/o/r/pull/3']);
    store.close();
  });

  it('offers a version 8 session every report, as its prompt did', () => {
    const path = join(dir, 'v8.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS.slice(0, 8).join(';'));
    raw.exec('PRAGMA user_version = 8');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (1, 'github', '1', 'a', 'u', 1, '')");
    raw.exec("INSERT INTO workItems (id, ticketId, status, createdAt) VALUES (1, 1, 'running', 1)");
    raw.exec("INSERT INTO sessions (id, workItemId, kind, provider, cwd, state, stateAt, startedAt, released) VALUES ('s1', 1, 'task', 'claude', 'C:/r', 'running', 1, 1, 0)");
    raw.close();

    const store = Store.open(path);

    expect(store.session('s1')?.reports).toEqual(['stage', 'worktree', 'done', 'approval', 'link']);
    store.updateSession('s1', { reports: ['stage', 'link'] });
    expect(store.session('s1')?.reports).toEqual(['stage', 'link']);
    store.updateSession('s1', { reports: [] });
    expect(store.session('s1')?.reports).toEqual([]);
    store.close();
  });

  it('clears the warning of a version 9 work item done because its ticket left the assigned state', () => {
    const path = join(dir, 'v9.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS.slice(0, 9).join(';'));
    raw.exec('PRAGMA user_version = 9');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (1, 'github', '1', 'a', 'u', 0, '')");
    raw.exec(
      "INSERT INTO workItems (id, ticketId, status, createdAt, doneReason, warning) VALUES (1, 1, 'done', 1, 'unassigned', 'Left.'), (2, 1, 'done', 1, 'session', 'Kept.'), (3, 1, 'blocked', 1, NULL, 'Kept.')",
    );
    // A session keeps item 1 through migration 16, which deletes sessionless items done as unassigned.
    raw.exec("INSERT INTO sessions (id, workItemId, kind, provider, cwd, state, stateAt, startedAt, released) VALUES ('s1', 1, 'task', 'claude', 'c', 'ended', 1, 1, 1)");
    raw.close();

    const store = Store.open(path);

    expect([1, 2, 3].map((id) => store.workItem(id)?.warning)).toEqual([null, 'Kept.', 'Kept.']);
    store.close();
  });

  it('refuses a database from a newer schema', () => {
    const path = join(dir, 'newer.db');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();

    expect(() => Store.open(path)).toThrow(`The database is schema version 99, newer than this hub supports (${MIGRATIONS.length}).`);
  });

  it('gives a version 14 work item no parent, and lists the work items a parent created', () => {
    const path = join(dir, 'v14.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS.slice(0, 14).join(';'));
    raw.exec('PRAGMA user_version = 14');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (1, 'github', '1', 'a', 'u', 1, '')");
    raw.exec("INSERT INTO workItems (id, ticketId, status, createdAt) VALUES (1, 1, 'running', 1)");
    raw.close();

    const store = Store.open(path);
    const { id: _, ...base } = store.workItem(1)!;
    const child = store.insertWorkItem({ ...base, status: 'unstarted', parentId: 1 });
    store.insertWorkItem({ ...base, status: 'unstarted', parentId: null });

    expect(store.workItem(1)?.parentId).toBeNull();
    expect(store.workItemsWithParent(1).map((item) => item.id)).toEqual([child.id]);
    expect(store.workItemsWithParent(child.id)).toEqual([]);
    store.close();
  });

  it('gives version 17 work items no held approval, and stores a held approval as a boolean', () => {
    const path = join(dir, 'v17.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS.slice(0, 17).join(';'));
    raw.exec('PRAGMA user_version = 17');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (1, 'github', '1', 'a', 'u', 1, '')");
    raw.exec("INSERT INTO workItems (id, ticketId, status, createdAt, approvalPrompt) VALUES (1, 1, 'awaiting-approval', 1, '/publish')");
    raw.close();

    const store = Store.open(path);

    expect(store.workItem(1)).toMatchObject({ status: 'awaiting-approval', approvalHeld: false });
    store.updateWorkItem(1, { status: 'running', approvalHeld: true });
    expect(store.workItem(1)?.approvalHeld).toBe(true);
    store.close();
  });

  it('makes a version 19 turn that finished without a done or approval report finished, and gives ready work items their readyAt', () => {
    const path = join(dir, 'v19.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS.slice(0, 19).join(';'));
    raw.exec('PRAGMA user_version = 19');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (1, 'github', '1', 'a', 'u', 1, '')");
    raw.exec(
      `INSERT INTO workItems (id, ticketId, status, error, createdAt, statusAt, approvalPrompt) VALUES
        (1, 1, 'blocked', 'The session finished its turn.', 1, 10, NULL), (2, 1, 'blocked', 'The session ended.', 1, 20, NULL),
        (3, 1, 'blocked', 'Stopped by you.', 1, 30, NULL), (4, 1, 'awaiting-approval', NULL, 1, 40, '/publish'),
        (5, 1, 'running', NULL, 1, 50, '/publish'), (6, 1, 'done', NULL, 1, 60, '/publish')`,
    );
    raw.close();

    const store = Store.open(path);

    expect([1, 2, 3, 4, 5, 6].map((id) => [store.workItem(id)?.status, store.workItem(id)?.error, store.workItem(id)?.readyAt, store.workItem(id)?.orderAt])).toEqual([
      ['finished', null, 10, null],
      ['finished', null, 20, null],
      ['blocked', 'Stopped by you.', null, null],
      ['awaiting-approval', null, 40, null],
      ['running', null, null, null],
      ['done', null, null, null],
    ]);
    store.close();
  });

  it('keeps version 15 work items with their sessions, triages, pastes and parents, deletes sessionless childless ones done as unassigned, never reuses a deleted ID, and enforces foreign keys after', () => {
    const path = join(dir, 'v15.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS.slice(0, 15).join(';'));
    raw.exec('PRAGMA user_version = 15');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (1, 'github', '1', 'a', 'u', 1, '')");
    raw.exec(
      "INSERT INTO workItems (id, ticketId, status, createdAt, statusAt, parentId, doneReason) VALUES (1, 1, 'done', 1, 2, NULL, 'unassigned'), (2, 1, 'unstarted', 3, 4, 1, NULL), " +
        "(3, 1, 'triaging', 5, 5, NULL, NULL), (4, 1, 'done', 6, 6, NULL, 'operator'), (5, 1, 'done', 7, 7, NULL, 'unassigned'), (6, 1, 'done', 8, 8, NULL, 'unassigned'), (7, 1, 'done', 9, 9, 6, 'operator')",
    );
    raw.exec("INSERT INTO sessions (id, workItemId, kind, provider, cwd, state, stateAt, startedAt, released) VALUES ('s1', 1, 'task', 'claude', 'c', 'ended', 1, 1, 1)");
    raw.exec("INSERT INTO triages (ticketId, workItemId, startedAt) VALUES (1, 1, 1), (1, 3, 5), (1, 5, 7)");
    raw.exec("INSERT INTO pastes (workItemId, label, file, reportedAt) VALUES (1, 'Reply', 'f', 1), (5, 'Reply', 'g', 7)");
    raw.close();

    const store = Store.open(path);

    // Item 1 has a session and item 6 a child, so only item 5 is deleted, with its triage and paste.
    expect(store.workItemsForTicket(1).map((item) => item.id)).toEqual([1, 2, 3, 4, 6, 7]);
    expect(store.pastesFor(5)).toEqual([]);
    expect(store.triagesFor(5)).toEqual([]);
    expect(store.workItem(2)).toMatchObject({ status: 'unstarted', createdAt: 3, statusAt: 4, parentId: 1 });
    expect(store.sessionsFor(1).map((session) => session.id)).toEqual(['s1']);
    expect(store.triagesFor(1)).toHaveLength(1);
    expect(store.pastesFor(1)).toHaveLength(1);

    store.deleteWorkItem(3);
    expect(store.workItem(3)).toBeNull();
    expect(store.triagesFor(3)).toEqual([]);
    const { id: _, ...base } = store.workItem(2)!;
    expect(store.insertWorkItem({ ...base, parentId: null }).id).toBe(8);
    const kept = store.sessionsFor(1)[0]!;
    store.deleteWorkItem(1);
    expect(store.workItem(1)).toBeNull();
    expect(store.session('s1')).toBeNull();
    expect(store.pastesFor(1)).toEqual([]);
    expect(store.workItem(2)?.parentId).toBeNull();
    expect(() => store.insertSession({ ...kept, id: 's2', workItemId: 99 })).toThrow(/FOREIGN KEY/);
    store.close();
  });

  it('keeps each source off until it is turned on, and keeps the latest state across reopening', () => {
    const path = join(dir, 'switchboard.db');
    const store = Store.open(path);

    expect(store.enabledSources()).toEqual(new Set());
    store.setSourceEnabled('github', true);
    store.setSourceEnabled('zoho', true);
    store.setSourceEnabled('zoho', false);
    store.close();

    const reopened = Store.open(path);

    expect(reopened.enabledSources()).toEqual(new Set(['github']));

    reopened.setSourceEnabled('forum', true);
    reopened.keepSourceStates(['forum', 'zoho']);
    expect(reopened.enabledSources()).toEqual(new Set(['forum']));
    reopened.keepSourceStates([]);
    expect(reopened.enabledSources()).toEqual(new Set());
    reopened.close();
  });

  it('finds the latest session with a Claude session ID', () => {
    const path = join(dir, 'native.db');
    Store.open(path).close();
    const raw = new DatabaseSync(path);
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (1, 'github', '1', 'a', 'u', 1, '')");
    raw.exec("INSERT INTO workItems (id, ticketId, status, createdAt, statusAt) VALUES (1, 1, 'running', 1, 1)");
    raw.exec(
      "INSERT INTO sessions (id, workItemId, kind, provider, nativeSessionId, cwd, state, stateAt, startedAt, released) VALUES " +
        "('s1', 1, 'task', 'claude', 'n1', 'c', 'ended', 1, 1, 1), ('s2', 1, 'task', 'claude', 'n1', 'c', 'running', 2, 2, 0), ('s3', 1, 'task', 'claude', 'n2', 'c', 'running', 3, 3, 0)",
    );
    raw.close();

    const store = Store.open(path);

    expect(store.sessionByNativeId('n1')?.id).toBe('s2');
    expect(store.sessionByNativeId('n2')?.id).toBe('s3');
    expect(store.sessionByNativeId('n3')).toBeNull();
    store.close();
  });

  it('rolls back a transaction that throws', () => {
    const store = Store.open(':memory:');

    expect(() =>
      store.transaction(() => {
        store.insertTicket({ source: 'github', sourceKey: '1', ref: '#1', sourceId: null, title: 'One', url: '', assigned: false, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.tickets('github')).toEqual([]);

    expect(store.transaction(() => store.insertTicket({ source: 'github', sourceKey: '2', ref: '#2', sourceId: null, title: 'Two', url: '', assigned: false, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' }).id)).toBe(1);
    expect(store.tickets('github')).toHaveLength(1);
  });

  it('finds an assigned or pool ticket by URL ignoring case, and no ticket out of scope or without a URL', () => {
    const store = Store.open(':memory:');
    const add = (sourceKey: string, url: string, assigned: boolean, pool: boolean) =>
      store.insertTicket({ source: 'github', sourceKey, ref: `#${sourceKey}`, sourceId: null, title: sourceKey, url, assigned, pool, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' }).id;

    add('1', 'https://github.com/o/r/issues/1', false, false);
    const assigned = add('2', 'https://github.com/O/R/issues/2', true, false);
    const pool = add('3', 'https://github.com/o/r/issues/3', false, true);
    add('4', '', true, false);

    expect(store.ticketInScopeByUrl('https://github.com/o/r/issues/2')?.id).toBe(assigned);
    expect(store.ticketInScopeByUrl('https://github.com/o/r/issues/3')?.id).toBe(pool);
    expect(store.ticketInScopeByUrl('https://github.com/o/r/issues/1')).toBeNull();
    expect(store.ticketInScopeByUrl('')).toBeNull();
    expect(store.ticketInScopeByUrl('https://github.com/o/r/issues/9')).toBeNull();
  });

  it('throws when an update matches no row', () => {
    const store = Store.open(':memory:');

    expect(() => store.updateTicket(9, { title: 'x' })).toThrow('No tickets row with id 9.');
    expect(() => store.updateSession('nope', { released: true })).toThrow('No sessions row with id nope.');
  });

  it('reads a ticket\'s history: work items newest first, each with its sessions and triages, and pool triages, without contexts or prompts (PRD R59)', () => {
    const path = join(dir, 'history.db');

    Store.open(path).close();

    const raw = new DatabaseSync(path);
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (1, 'github', '1', 'a', 'u', 1, ''), (2, 'github', '2', 'b', 'u', 1, '')");
    raw.exec(
      "INSERT INTO workItems (id, ticketId, playbook, status, taskPrompt, createdAt) VALUES (1, 1, 'dev:review-pr', 'done', 'Review.', 10), (2, 1, 'dev:review-pr', 'running', 'Review again.', 20), (3, 2, 'dev:develop', 'running', NULL, 15)",
    );
    raw.exec(
      "INSERT INTO sessions (id, workItemId, kind, provider, cwd, state, stateAt, startedAt, released) VALUES ('t1', 1, 'task', 'claude', 'C:/r', 'ended', 1, 12, 0), ('s1', 1, 'setup', 'claude', 'C:/r', 'ended', 1, 11, 0), ('t2', 2, 'task', 'claude', 'C:/r', 'running', 1, 21, 0), ('x', 3, 'task', 'claude', 'C:/r', 'running', 1, 16, 0)",
    );
    raw.exec(
      "INSERT INTO triages (id, ticketId, workItemId, context, playbook, startedAt, endedAt, error) VALUES (1, 1, 1, 'Context one.', 'dev:review-pr', 10, 11, NULL), (2, 1, NULL, 'Pool context.', NULL, 5, 6, 'Timed out.'), (3, 1, 2, 'Context two.', 'dev:review-pr', 20, 21, NULL), (4, 2, 3, 'Other.', 'dev:develop', 15, 16, NULL)",
    );
    raw.close();

    const store = Store.open(path);
    const history = store.ticketHistory(1)!;

    expect(history.ticket.id).toBe(1);
    expect(history.workItems.map((item) => [item.id, item.sessions.map((session) => session.id), item.triages.map((triage) => triage.id)])).toEqual([
      [2, ['t2'], [3]],
      [1, ['s1', 't1'], [1]],
    ]);
    expect(history.poolTriages).toEqual([{ id: 2, ticketId: 1, workItemId: null, playbook: null, immediacy: null, severity: null, model: null, startedAt: 5, endedAt: 6, error: 'Timed out.' }]);
    expect(history.workItems[0]).not.toHaveProperty('taskPrompt');
    expect(history.workItems[0]!.triages[0]).not.toHaveProperty('context');
    expect(store.ticketHistory(9)).toBeNull();
    store.close();
  });

  it('replaces a ticket worktree link', () => {
    const store = Store.open(':memory:');
    const ticket = store.insertTicket({ source: 'github', sourceKey: '1', ref: '#1', sourceId: null, title: 'One', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });

    store.linkWorktree({ ticketId: ticket.id, path: 'D:/wt/a', branch: '1-a', linkedBy: 'convention' });
    store.linkWorktree({ ticketId: ticket.id, path: 'D:/wt/b', branch: null, linkedBy: 'report' });

    expect(store.worktreeFor(ticket.id)).toEqual({ id: 1, ticketId: 1, path: 'D:/wt/b', branch: null, linkedBy: 'report' });
  });

  it('keeps one paste per label per work item, replacing its file in place (R60)', () => {
    const store = Store.open(':memory:');
    const ticket = store.insertTicket({ source: 'zoho', sourceKey: '1', ref: '#1', sourceId: null, title: 'One', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
    const item = (id: number) => ({ ticketId: ticket.id, playbook: 'support:defect', status: 'running', stage: null, stageAt: null, taskPrompt: null, guidance: null, warning: null, error: null, unassignedAt: null, queuedAt: null, approvalPrompt: null, approvalSummary: null, approvalReport: null, approvalHeld: false, createdAt: id, statusAt: id, runStartedAt: null, readyAt: null, orderAt: null, scopeAt: null, doneAt: null, doneReason: null, parentId: null }) as const;
    const first = store.insertWorkItem(item(1));
    const second = store.insertWorkItem(item(2));

    store.setPaste({ workItemId: first.id, label: 'Customer reply', file: 'D:/case/draft-reply.md', reportedAt: 1 });
    store.setPaste({ workItemId: first.id, label: 'Private note', file: 'D:/case/private-note.md', reportedAt: 2 });
    store.setPaste({ workItemId: second.id, label: 'Customer reply', file: 'D:/case/other.md', reportedAt: 3 });
    store.setPaste({ workItemId: first.id, label: 'Customer reply', file: 'D:/case/draft-reply-2.md', reportedAt: 4 });

    expect(store.pastesFor(first.id)).toEqual([
      { id: 1, workItemId: first.id, label: 'Customer reply', file: 'D:/case/draft-reply-2.md', reportedAt: 4 },
      { id: 2, workItemId: first.id, label: 'Private note', file: 'D:/case/private-note.md', reportedAt: 2 },
    ]);
    expect(store.pastesFor(second.id).map((paste) => paste.file)).toEqual(['D:/case/other.md']);
  });
});
