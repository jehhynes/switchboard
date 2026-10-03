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

    store.insertTicket({ source: 'github', sourceKey: '1', sourceId: null, title: 'One', url: 'u', assigned: true, pool: false, iceboxed: false, sortAt: null, lastPolledAt: 5, repoRoot: '' });
    store.close();

    const raw = new DatabaseSync(path);
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    raw.close();

    const reopened = Store.open(path);
    expect(reopened.findTicket('github', '1')).toEqual({ id: 1, source: 'github', sourceKey: '1', sourceId: null, title: 'One', url: 'u', assigned: true, pool: false, iceboxed: false, sortAt: null, lastPolledAt: 5, repoRoot: '' });
    reopened.close();
  });

  it('moves a version 1 database to the pool schema, keeping each triage with its ticket', () => {
    const path = join(dir, 'v1.db');
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS[0]!);
    raw.exec('PRAGMA user_version = 1');
    raw.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, repoRoot) VALUES (7, 'github', '1', 'One', 'u', 1, '')");
    raw.exec("INSERT INTO workItems (id, ticketId, status, queuedAt, createdAt) VALUES (3, 7, 'awaiting-approval', NULL, 1)");
    raw.exec("INSERT INTO triages (id, workItemId, summary, startedAt, endedAt) VALUES (5, 3, 'A summary.', 1, 2)");
    raw.close();

    const store = Store.open(path);

    expect(store.ticket(7)).toMatchObject({ pool: false, iceboxed: false, sortAt: null });
    expect(store.workItem(3)).toMatchObject({ needsPick: false, approvalPrompt: null, approvalSummary: null });
    expect(store.triagesFor(3)).toEqual([{ id: 5, ticketId: 7, workItemId: 3, context: null, playbook: null, summary: 'A summary.', model: null, startedAt: 1, endedAt: 2, error: null }]);
    store.close();
  });

  it('refuses a database from a newer schema', () => {
    const path = join(dir, 'newer.db');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();

    expect(() => Store.open(path)).toThrow('The database is schema version 99, newer than this hub supports (2).');
  });

  it('rolls back a transaction that throws', () => {
    const store = Store.open(':memory:');

    expect(() =>
      store.transaction(() => {
        store.insertTicket({ source: 'github', sourceKey: '1', sourceId: null, title: 'One', url: '', assigned: false, pool: false, iceboxed: false, sortAt: null, lastPolledAt: null, repoRoot: '' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.tickets('github')).toEqual([]);

    expect(store.transaction(() => store.insertTicket({ source: 'github', sourceKey: '2', sourceId: null, title: 'Two', url: '', assigned: false, pool: false, iceboxed: false, sortAt: null, lastPolledAt: null, repoRoot: '' }).id)).toBe(1);
    expect(store.tickets('github')).toHaveLength(1);
  });

  it('throws when an update matches no row', () => {
    const store = Store.open(':memory:');

    expect(() => store.updateTicket(9, { title: 'x' })).toThrow('No tickets row with id 9.');
    expect(() => store.updateSession('nope', { released: true })).toThrow('No sessions row with id nope.');
  });

  it('replaces a ticket worktree link', () => {
    const store = Store.open(':memory:');
    const ticket = store.insertTicket({ source: 'github', sourceKey: '1', sourceId: null, title: 'One', url: '', assigned: true, pool: false, iceboxed: false, sortAt: null, lastPolledAt: null, repoRoot: '' });

    store.linkWorktree({ ticketId: ticket.id, path: 'D:/wt/a', branch: '1-a', linkedBy: 'convention' });
    store.linkWorktree({ ticketId: ticket.id, path: 'D:/wt/b', branch: null, linkedBy: 'report' });

    expect(store.worktreeFor(ticket.id)).toEqual({ id: 1, ticketId: 1, path: 'D:/wt/b', branch: null, linkedBy: 'report' });
  });
});
