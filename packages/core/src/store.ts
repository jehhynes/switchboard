import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Link, Session, Ticket, Triage, WorkItem, WorkItemStatus, Worktree } from './model.js';

export const MIGRATIONS = [
  `CREATE TABLE tickets (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    sourceKey TEXT NOT NULL,
    sourceId TEXT,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    assigned INTEGER NOT NULL,
    lastPolledAt INTEGER,
    repoRoot TEXT NOT NULL,
    UNIQUE (source, sourceKey)
  );
  CREATE TABLE workItems (
    id INTEGER PRIMARY KEY,
    ticketId INTEGER NOT NULL REFERENCES tickets(id),
    playbook TEXT,
    status TEXT NOT NULL,
    stage TEXT,
    stageAt INTEGER,
    taskPrompt TEXT,
    warning TEXT,
    error TEXT,
    failedStep TEXT,
    unassignedAt INTEGER,
    queuedAt INTEGER,
    createdAt INTEGER NOT NULL,
    doneAt INTEGER,
    doneReason TEXT
  );
  CREATE INDEX workItemsByTicket ON workItems (ticketId);
  CREATE INDEX workItemsByStatus ON workItems (status);
  CREATE TABLE triages (
    id INTEGER PRIMARY KEY,
    workItemId INTEGER NOT NULL REFERENCES workItems(id),
    context TEXT,
    playbook TEXT,
    summary TEXT,
    model TEXT,
    startedAt INTEGER NOT NULL,
    endedAt INTEGER,
    error TEXT
  );
  CREATE INDEX triagesByWorkItem ON triages (workItemId);
  CREATE TABLE worktrees (
    id INTEGER PRIMARY KEY,
    ticketId INTEGER NOT NULL UNIQUE REFERENCES tickets(id),
    path TEXT NOT NULL,
    branch TEXT,
    linkedBy TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    workItemId INTEGER NOT NULL REFERENCES workItems(id),
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    nativeSessionId TEXT,
    shortId TEXT,
    cwd TEXT NOT NULL,
    state TEXT NOT NULL,
    stateAt INTEGER NOT NULL,
    stateDetail TEXT,
    outcome TEXT,
    outcomeDetail TEXT,
    startedAt INTEGER NOT NULL,
    endedAt INTEGER,
    released INTEGER NOT NULL
  );
  CREATE INDEX sessionsByWorkItem ON sessions (workItemId);`,
  // The pool (PRD R47, R48): a triage can belong to a ticket before it has a work item.
  `ALTER TABLE tickets ADD COLUMN pool INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tickets ADD COLUMN sortAt INTEGER;
  ALTER TABLE workItems ADD COLUMN needsPick INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE workItems ADD COLUMN approvalPrompt TEXT;
  ALTER TABLE workItems ADD COLUMN approvalSummary TEXT;
  ALTER TABLE tickets ADD COLUMN iceboxed INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE triagesByTicket (
    -- Never reused: a late classifier result for a deleted pool triage must not land on a newer one.
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticketId INTEGER NOT NULL REFERENCES tickets(id),
    workItemId INTEGER REFERENCES workItems(id),
    context TEXT,
    playbook TEXT,
    summary TEXT,
    model TEXT,
    startedAt INTEGER NOT NULL,
    endedAt INTEGER,
    error TEXT
  );
  INSERT INTO triagesByTicket (id, ticketId, workItemId, context, playbook, summary, model, startedAt, endedAt, error)
    SELECT t.id, w.ticketId, t.workItemId, t.context, t.playbook, t.summary, t.model, t.startedAt, t.endedAt, t.error FROM triages t JOIN workItems w ON w.id = t.workItemId;
  DROP TABLE triages;
  ALTER TABLE triagesByTicket RENAME TO triages;
  CREATE INDEX triagesByWorkItem ON triages (workItemId);
  CREATE INDEX triagesByTicket ON triages (ticketId);`,
  // Importance and links (PRD R50, R52).
  `ALTER TABLE triages ADD COLUMN immediacy TEXT;
  ALTER TABLE triages ADD COLUMN severity TEXT;
  CREATE TABLE links (
    id INTEGER PRIMARY KEY,
    ticketId INTEGER NOT NULL REFERENCES tickets(id),
    label TEXT NOT NULL,
    target TEXT NOT NULL,
    reportedAt INTEGER NOT NULL,
    UNIQUE (ticketId, target)
  );`,
  // `awaiting-approval` now means only an approval report; a work item waiting to be started is `unstarted` (PRD R34).
  `UPDATE workItems SET status = 'unstarted' WHERE status = 'awaiting-approval' AND approvalPrompt IS NULL;`,
  // The source's reference for a ticket (`{{ticket.ref}}`); the next poll fills polled tickets, and ad-hoc ones are `#<n>`.
  `ALTER TABLE tickets ADD COLUMN ref TEXT NOT NULL DEFAULT '';
  UPDATE tickets SET ref = '#' || sourceKey WHERE source = 'adhoc';`,
  // In-queue times (PRD R27). Polls fill a polled ticket's scopeAt; the rest are estimated from the times already stored.
  `ALTER TABLE tickets ADD COLUMN scopeAt INTEGER;
  UPDATE tickets SET scopeAt = (SELECT MIN(w.createdAt) FROM workItems w WHERE w.ticketId = tickets.id) WHERE source = 'adhoc';
  ALTER TABLE workItems ADD COLUMN statusAt INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE workItems ADD COLUMN runStartedAt INTEGER;
  ALTER TABLE workItems ADD COLUMN scopeAt INTEGER;
  UPDATE workItems SET
    statusAt = CASE
      WHEN status = 'done' THEN COALESCE(doneAt, createdAt)
      WHEN status = 'queued' THEN COALESCE(queuedAt, createdAt)
      WHEN status IN ('blocked', 'failed', 'awaiting-approval') THEN COALESCE((SELECT MAX(COALESCE(s.endedAt, s.stateAt)) FROM sessions s WHERE s.workItemId = workItems.id), createdAt)
      WHEN status IN ('setup', 'running') THEN COALESCE((SELECT MAX(s.startedAt) FROM sessions s WHERE s.workItemId = workItems.id), createdAt)
      ELSE createdAt
    END,
    runStartedAt = CASE
      WHEN status = 'queued' THEN COALESCE(queuedAt, createdAt)
      ELSE COALESCE((SELECT MAX(s.startedAt) FROM sessions s WHERE s.workItemId = workItems.id), createdAt)
    END,
    scopeAt = CASE WHEN status = 'done' THEN createdAt END;`,
  // The Icebox becomes Snoozed with a wake time (PRD R49); an iceboxed ticket stays snoozed indefinitely.
  `ALTER TABLE tickets RENAME COLUMN iceboxed TO snoozed;
  ALTER TABLE tickets ADD COLUMN snoozedUntil INTEGER;`,
  // An approval report names its draft, and links are URLs only (PRD R23, R52); an open approval keeps its newest linked file as its draft.
  `ALTER TABLE workItems ADD COLUMN approvalReport TEXT;
  UPDATE workItems SET approvalReport = (
    SELECT l.target FROM links l WHERE l.ticketId = workItems.ticketId AND l.target NOT LIKE 'http://%' AND l.target NOT LIKE 'https://%' ORDER BY l.reportedAt DESC, l.id DESC LIMIT 1
  ) WHERE status = 'awaiting-approval';
  DELETE FROM links WHERE target NOT LIKE 'http://%' AND target NOT LIKE 'https://%';`,
  // Each session keeps the reports its prompt offered (PRD R23); earlier sessions were offered all of them.
  `ALTER TABLE sessions ADD COLUMN reports TEXT NOT NULL DEFAULT 'stage,worktree,done,approval,link';`,
  // A work item done because its ticket left the assigned state has no warning (PRD R11).
  `UPDATE workItems SET warning = NULL WHERE status = 'done' AND doneReason = 'unassigned';`,
  // A ticket out of the source's scope is not snoozed (PRD R49).
  `UPDATE tickets SET snoozed = 0, snoozedUntil = NULL WHERE snoozed = 1 AND assigned = 0 AND pool = 0;`,
  // Pick sessions are gone; the task session's skill claims the ticket (PRD R48). An open picked work item waits for Retry, which starts its task.
  `UPDATE workItems SET status = 'blocked', failedStep = 'task', error = COALESCE(error, 'Pick sessions were removed. Retry starts the playbook, which claims the ticket.')
    WHERE needsPick = 1 AND status <> 'done';
  ALTER TABLE workItems DROP COLUMN needsPick;`,
  // Triage no longer writes a summary (PRD R18).
  `ALTER TABLE triages DROP COLUMN summary;`,
];

const BOOLEANS = new Set(['assigned', 'pool', 'snoozed', 'released']);
/** Stored as comma-separated text. */
const LISTS = new Set(['reports']);

type Row = Record<string, unknown>;

function fromRow<T>(row: Row | undefined): T | null {
  if (row === undefined) {
    return null;
  }

  const result: Row = {};

  for (const [key, value] of Object.entries(row)) {
    result[key] = BOOLEANS.has(key) ? value === 1 : LISTS.has(key) ? String(value).split(',').filter((entry) => entry !== '') : value;
  }

  return result as T;
}

function toParams(values: Row): Record<string, SQLInputValue> {
  const result: Record<string, SQLInputValue> = {};

  for (const [key, value] of Object.entries(values)) {
    result[key] = typeof value === 'boolean' ? (value ? 1 : 0) : Array.isArray(value) ? value.join(',') : (value as SQLInputValue);
  }

  return result;
}

export type NewTicket = Omit<Ticket, 'id'>;
export type NewWorkItem = Omit<WorkItem, 'id'>;
export type NewTriage = Omit<Triage, 'id'>;
export type NewWorktree = Omit<Worktree, 'id'>;

/** All database access. The hub is the only process that opens the database. */
export class Store {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Opens or creates the database and applies pending migrations. Use `:memory:` in tests. */
  static open(path: string): Store {
    // Loaded on first use, so importing core (as the extension does) does not load SQLite or print its experimental warning.
    const { DatabaseSync: Database } = process.getBuiltinModule('node:sqlite');
    const db = new Database(path);

    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

    if (version > MIGRATIONS.length) {
      db.close();
      throw new Error(`The database is schema version ${version}, newer than this hub supports (${MIGRATIONS.length}).`);
    }

    for (let next = version; next < MIGRATIONS.length; next++) {
      db.exec('BEGIN');

      try {
        db.exec(MIGRATIONS[next]!);
        db.exec(`PRAGMA user_version = ${next + 1}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        db.close();
        throw error;
      }
    }

    return new Store(db);
  }

  close(): void {
    this.#db.close();
  }

  /** Runs `fn` in one write transaction; an exception rolls it back. */
  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');

    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #insert(table: string, values: Row): number {
    const keys = Object.keys(values);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((key) => `:${key}`).join(', ')})`;

    return Number(this.#db.prepare(sql).run(toParams(values)).lastInsertRowid);
  }

  #update(table: string, id: number | string, patch: Row): void {
    const keys = Object.keys(patch);

    if (keys.length === 0) {
      return;
    }

    const sql = `UPDATE ${table} SET ${keys.map((key) => `${key} = :${key}`).join(', ')} WHERE id = :id`;
    const result = this.#db.prepare(sql).run(toParams({ ...patch, id }));

    if (result.changes !== 1) {
      throw new Error(`No ${table} row with id ${id}.`);
    }
  }

  #one<T>(sql: string, ...params: SQLInputValue[]): T | null {
    return fromRow<T>(this.#db.prepare(sql).get(...params) as Row | undefined);
  }

  #all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return (this.#db.prepare(sql).all(...params) as Row[]).map((row) => fromRow<T>(row)!);
  }

  insertTicket(ticket: NewTicket): Ticket {
    return { id: this.#insert('tickets', ticket as unknown as Row), ...ticket };
  }

  updateTicket(id: number, patch: Partial<NewTicket>): void {
    this.#update('tickets', id, patch);
  }

  ticket(id: number): Ticket | null {
    return this.#one('SELECT * FROM tickets WHERE id = ?', id);
  }

  findTicket(source: string, sourceKey: string): Ticket | null {
    return this.#one('SELECT * FROM tickets WHERE source = ? AND sourceKey = ?', source, sourceKey);
  }

  tickets(source: string): Ticket[] {
    return this.#all('SELECT * FROM tickets WHERE source = ? ORDER BY id', source);
  }

  insertWorkItem(item: NewWorkItem): WorkItem {
    return { id: this.#insert('workItems', item as unknown as Row), ...item };
  }

  updateWorkItem(id: number, patch: Partial<NewWorkItem>): void {
    this.#update('workItems', id, patch);
  }

  workItem(id: number): WorkItem | null {
    return this.#one('SELECT * FROM workItems WHERE id = ?', id);
  }

  workItemsForTicket(ticketId: number): WorkItem[] {
    return this.#all('SELECT * FROM workItems WHERE ticketId = ? ORDER BY id', ticketId);
  }

  workItemsWithStatus(status: WorkItemStatus): WorkItem[] {
    return this.#all('SELECT * FROM workItems WHERE status = ? ORDER BY id', status);
  }

  /** Work items not done, those done since `doneSince`, and every work item of a snoozed ticket, newest first. */
  workItems(doneSince: number): WorkItem[] {
    return this.#all(
      "SELECT w.* FROM workItems w JOIN tickets t ON t.id = w.ticketId WHERE w.status <> 'done' OR w.doneAt >= ? OR t.snoozed = 1 ORDER BY w.id DESC",
      doneSince,
    );
  }

  /** Tickets snoozed at `now`: indefinitely, or until a later time. */
  snoozedTickets(now: number): Ticket[] {
    return this.#all('SELECT * FROM tickets WHERE snoozed = 1 AND (snoozedUntil IS NULL OR snoozedUntil > ?) ORDER BY id', now);
  }

  /** Snoozed tickets whose wake time has passed. */
  dueSnoozes(now: number): Ticket[] {
    return this.#all('SELECT * FROM tickets WHERE snoozed = 1 AND snoozedUntil IS NOT NULL AND snoozedUntil <= ? ORDER BY id', now);
  }

  insertTriage(triage: NewTriage): Triage {
    return { id: this.#insert('triages', triage as unknown as Row), ...triage };
  }

  updateTriage(id: number, patch: Partial<NewTriage>): void {
    this.#update('triages', id, patch);
  }

  triage(id: number): Triage | null {
    return this.#one('SELECT * FROM triages WHERE id = ?', id);
  }

  triagesFor(workItemId: number): Triage[] {
    return this.#all('SELECT * FROM triages WHERE workItemId = ? ORDER BY id', workItemId);
  }

  /** Triages of a ticket made while it was in the pool and not yet attached to a work item. */
  poolTriages(ticketId: number): Triage[] {
    return this.#all('SELECT * FROM triages WHERE ticketId = ? AND workItemId IS NULL ORDER BY id', ticketId);
  }

  deleteTriage(id: number): void {
    this.#db.prepare('DELETE FROM triages WHERE id = ?').run(id);
  }

  /** Tickets in the pool, the longest-waiting customer first. */
  poolTickets(): Ticket[] {
    return this.#all('SELECT * FROM tickets WHERE pool = 1 ORDER BY sortAt IS NULL, sortAt, id');
  }

  runningTriages(): Triage[] {
    return this.#all('SELECT * FROM triages WHERE endedAt IS NULL ORDER BY id');
  }

  worktreeFor(ticketId: number): Worktree | null {
    return this.#one('SELECT * FROM worktrees WHERE ticketId = ?', ticketId);
  }

  /** Links the ticket's worktree, replacing an earlier link. */
  linkWorktree(worktree: NewWorktree): void {
    this.#db
      .prepare(
        'INSERT INTO worktrees (ticketId, path, branch, linkedBy) VALUES (:ticketId, :path, :branch, :linkedBy) ' +
          'ON CONFLICT (ticketId) DO UPDATE SET path = excluded.path, branch = excluded.branch, linkedBy = excluded.linkedBy',
      )
      .run(toParams(worktree as unknown as Row));
  }

  /** Adds a link to the ticket; a link to the same target replaces its label. */
  addLink(link: Omit<Link, 'id'>): void {
    this.#db
      .prepare(
        'INSERT INTO links (ticketId, label, target, reportedAt) VALUES (:ticketId, :label, :target, :reportedAt) ' +
          'ON CONFLICT (ticketId, target) DO UPDATE SET label = excluded.label, reportedAt = excluded.reportedAt',
      )
      .run(toParams(link as unknown as Row));
  }

  linksFor(ticketId: number): Link[] {
    return this.#all('SELECT * FROM links WHERE ticketId = ? ORDER BY id', ticketId);
  }

  insertSession(session: Session): void {
    this.#insert('sessions', session as unknown as Row);
  }

  updateSession(id: string, patch: Partial<Omit<Session, 'id'>>): void {
    this.#update('sessions', id, patch);
  }

  session(id: string): Session | null {
    return this.#one('SELECT * FROM sessions WHERE id = ?', id);
  }

  sessionsFor(workItemId: number): Session[] {
    return this.#all('SELECT * FROM sessions WHERE workItemId = ? ORDER BY startedAt, rowid', workItemId);
  }

  /** Sessions whose process may be running: every state but `ended`. */
  activeSessions(): Session[] {
    return this.#all("SELECT * FROM sessions WHERE state <> 'ended' ORDER BY startedAt, rowid");
  }

  /** Sessions a start confirmed: a roster read can end them, or revive one the operator resumed. */
  startedSessions(): Session[] {
    return this.#all('SELECT * FROM sessions WHERE shortId IS NOT NULL ORDER BY startedAt, rowid');
  }

  activeSessionsForTicket(ticketId: number): Session[] {
    return this.#all(
      "SELECT s.* FROM sessions s JOIN workItems w ON w.id = s.workItemId WHERE w.ticketId = ? AND s.state <> 'ended' ORDER BY s.startedAt, s.rowid",
      ticketId,
    );
  }

}
