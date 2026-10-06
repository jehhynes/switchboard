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
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 });
    expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    raw.close();

    const reopened = Store.open(path);
    expect(reopened.findTicket('github', '1')).toEqual({ id: 1, source: 'github', sourceKey: '1', ref: '#1', sourceId: null, title: 'One', url: 'u', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: 5, repoRoot: '' });
    reopened.close();
  });

  it('moves a version 1 database to the current schema, keeping each triage with its ticket and leaving it unrated', () => {
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
    expect(store.workItem(3)).toMatchObject({ status: 'unstarted', needsPick: false, approvalPrompt: null, approvalSummary: null });
    expect(store.triagesFor(3)).toEqual([{ id: 5, ticketId: 7, workItemId: 3, context: null, playbook: null, summary: 'A summary.', immediacy: null, severity: null, model: null, startedAt: 1, endedAt: 2, error: null }]);
    store.close();
  });

  it('moves a version 6 iceboxed ticket to an indefinite snooze, and lists only timed snoozes that are due', () => {
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

    expect(() => Store.open(path)).toThrow('The database is schema version 99, newer than this hub supports (11).');
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

  it('throws when an update matches no row', () => {
    const store = Store.open(':memory:');

    expect(() => store.updateTicket(9, { title: 'x' })).toThrow('No tickets row with id 9.');
    expect(() => store.updateSession('nope', { released: true })).toThrow('No sessions row with id nope.');
  });

  it('replaces a ticket worktree link', () => {
    const store = Store.open(':memory:');
    const ticket = store.insertTicket({ source: 'github', sourceKey: '1', ref: '#1', sourceId: null, title: 'One', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });

    store.linkWorktree({ ticketId: ticket.id, path: 'D:/wt/a', branch: '1-a', linkedBy: 'convention' });
    store.linkWorktree({ ticketId: ticket.id, path: 'D:/wt/b', branch: null, linkedBy: 'report' });

    expect(store.worktreeFor(ticket.id)).toEqual({ id: 1, ticketId: 1, path: 'D:/wt/b', branch: null, linkedBy: 'report' });
  });
});
