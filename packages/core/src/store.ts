import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Session, Ticket, Triage, WorkItem, WorkItemStatus, Worktree } from './model.js';

const MIGRATIONS = [
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
];

const BOOLEANS = new Set(['assigned', 'released']);

type Row = Record<string, unknown>;

function fromRow<T>(row: Row | undefined): T | null {
  if (row === undefined) {
    return null;
  }

  const result: Row = {};

  for (const [key, value] of Object.entries(row)) {
    result[key] = BOOLEANS.has(key) ? value === 1 : value;
  }

  return result as T;
}

function toParams(values: Row): Record<string, SQLInputValue> {
  const result: Record<string, SQLInputValue> = {};

  for (const [key, value] of Object.entries(values)) {
    result[key] = typeof value === 'boolean' ? (value ? 1 : 0) : (value as SQLInputValue);
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

  /** Work items not done, plus those done since `doneSince`, newest first. */
  workItems(doneSince: number): WorkItem[] {
    return this.#all("SELECT * FROM workItems WHERE status <> 'done' OR doneAt >= ? ORDER BY id DESC", doneSince);
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
