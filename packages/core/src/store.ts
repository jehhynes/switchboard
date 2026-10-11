import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Link, Paste, Session, Ticket, Triage, WorkItem, WorkItemStatus, Worktree } from './model.js';

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
  // Drafted texts the operator copies into the source (PRD R60); one per label per work item.
  `CREATE TABLE pastes (
    id INTEGER PRIMARY KEY,
    workItemId INTEGER NOT NULL REFERENCES workItems(id),
    label TEXT NOT NULL,
    file TEXT NOT NULL,
    reportedAt INTEGER NOT NULL,
    UNIQUE (workItemId, label)
  );`,
  // A session's task report records the work item it came from (PRD R68).
  `ALTER TABLE workItems ADD COLUMN parentId INTEGER REFERENCES workItems(id);`,
  // A work item that never had a session is deleted when its ticket leaves (PRD R10), so IDs must not be reused: the dock can act on a stale one.
  `CREATE TABLE workItemsNew (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    doneReason TEXT,
    approvalPrompt TEXT,
    approvalSummary TEXT,
    statusAt INTEGER NOT NULL DEFAULT 0,
    runStartedAt INTEGER,
    scopeAt INTEGER,
    approvalReport TEXT,
    parentId INTEGER REFERENCES workItems(id)
  );
  INSERT INTO workItemsNew (id, ticketId, playbook, status, stage, stageAt, taskPrompt, warning, error, failedStep, unassignedAt, queuedAt, createdAt, doneAt, doneReason,
      approvalPrompt, approvalSummary, statusAt, runStartedAt, scopeAt, approvalReport, parentId)
    SELECT id, ticketId, playbook, status, stage, stageAt, taskPrompt, warning, error, failedStep, unassignedAt, queuedAt, createdAt, doneAt, doneReason,
      approvalPrompt, approvalSummary, statusAt, runStartedAt, scopeAt, approvalReport, parentId FROM workItems;
  DROP TABLE workItems;
  ALTER TABLE workItemsNew RENAME TO workItems;
  CREATE INDEX workItemsByTicket ON workItems (ticketId);
  CREATE INDEX workItemsByStatus ON workItems (status);
  CREATE TEMP TABLE sessionless AS SELECT id FROM workItems w
    WHERE doneReason = 'unassigned' AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.workItemId = w.id) AND NOT EXISTS (SELECT 1 FROM workItems c WHERE c.parentId = w.id);
  DELETE FROM triages WHERE workItemId IN (SELECT id FROM sessionless);
  DELETE FROM pastes WHERE workItemId IN (SELECT id FROM sessionless);
  DELETE FROM workItems WHERE id IN (SELECT id FROM sessionless);
  DROP TABLE sessionless;`,
  // The activity log (PRD R59): each flow event that wrote or was refused, and each row it wrote. No foreign keys, so a deleted row keeps its log.
  `CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    actor TEXT NOT NULL,
    ticketId INTEGER,
    workItemId INTEGER,
    sessionId TEXT,
    detail TEXT,
    refused TEXT
  );
  CREATE INDEX eventsByTicket ON events (ticketId);
  CREATE TABLE changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eventId INTEGER NOT NULL,
    ticketId INTEGER NOT NULL,
    workItemId INTEGER,
    sessionId TEXT,
    entity TEXT NOT NULL,
    entityId TEXT NOT NULL,
    op TEXT NOT NULL,
    fields TEXT NOT NULL
  );
  CREATE INDEX changesByTicket ON changes (ticketId);
  CREATE INDEX changesByWorkItem ON changes (workItemId);
  -- Counts every write to a ticket's log, deletions too, so a reader can tell whether its copy is current.
  CREATE TABLE historyRevisions (ticketId INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
  INSERT INTO events (at, type, actor) VALUES (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 'recording', 'hub');
  -- Facts the stored times still show about earlier work, before the log began; later changes to those rows cannot alter them.
  INSERT INTO events (at, type, actor, ticketId, workItemId, sessionId, detail)
    SELECT at, 'reconstructed', 'hub', ticketId, workItemId, sessionId, detail FROM (
      SELECT createdAt AS at, ticketId, id AS workItemId, NULL AS sessionId, json_object('fact', 'created', 'playbook', playbook, 'parentId', parentId) AS detail FROM workItems
      UNION ALL SELECT startedAt, ticketId, workItemId, NULL, json_object('fact', 'triageStarted', 'triageId', id) FROM triages
      UNION ALL SELECT endedAt, ticketId, workItemId, NULL, json_object('fact', 'triageEnded', 'triageId', id, 'playbook', playbook, 'error', error, 'immediacy', immediacy, 'severity', severity)
        FROM triages WHERE endedAt IS NOT NULL
      UNION ALL SELECT s.startedAt, w.ticketId, s.workItemId, s.id, json_object('fact', 'sessionStarted', 'kind', s.kind, 'state', s.state) FROM sessions s JOIN workItems w ON w.id = s.workItemId
      UNION ALL SELECT s.endedAt, w.ticketId, s.workItemId, s.id, json_object('fact', 'sessionEnded', 'kind', s.kind, 'outcome', s.outcome, 'outcomeDetail', s.outcomeDetail)
        FROM sessions s JOIN workItems w ON w.id = s.workItemId WHERE s.endedAt IS NOT NULL
      UNION ALL SELECT stageAt, ticketId, id, NULL, json_object('fact', 'stage', 'stage', stage) FROM workItems WHERE stage IS NOT NULL AND stageAt IS NOT NULL
      UNION ALL SELECT statusAt, ticketId, id, NULL, json_object('fact', 'status', 'status', status, 'error', error, 'approvalSummary', approvalSummary, 'approvalReport', approvalReport)
        FROM workItems WHERE status IN ('awaiting-approval', 'blocked', 'failed') AND statusAt > 0
      UNION ALL SELECT doneAt, ticketId, id, NULL, json_object('fact', 'done', 'reason', doneReason) FROM workItems WHERE doneAt IS NOT NULL
      UNION ALL SELECT reportedAt, ticketId, NULL, NULL, json_object('fact', 'link', 'label', label, 'target', target) FROM links
      UNION ALL SELECT p.reportedAt, w.ticketId, p.workItemId, NULL, json_object('fact', 'paste', 'label', p.label, 'file', p.file) FROM pastes p JOIN workItems w ON w.id = p.workItemId
    ) ORDER BY at;
  INSERT INTO historyRevisions (ticketId, revision) SELECT ticketId, COUNT(*) FROM events WHERE ticketId IS NOT NULL GROUP BY ticketId;`,
  `ALTER TABLE workItems ADD COLUMN approvalHeld INTEGER NOT NULL DEFAULT 0;`,
  // Retry is gone; Triage again recovers a failed or blocked work item.
  `ALTER TABLE workItems DROP COLUMN failedStep;
  UPDATE workItems SET error = 'Pick sessions were removed. Triage again triages the ticket, and its task claims it.'
    WHERE error = 'Pick sessions were removed. Retry starts the playbook, which claims the ticket.';`,
  // A turn that ended on a playbook offering neither done nor approval is finished, for review; Ready for review sorts by readyAt (PRD R27).
  `ALTER TABLE workItems ADD COLUMN readyAt INTEGER;
  ALTER TABLE workItems ADD COLUMN orderAt INTEGER;
  UPDATE workItems SET status = 'finished', error = NULL WHERE status = 'blocked' AND error IN ('The session finished its turn.', 'The session ended.');
  UPDATE workItems SET readyAt = statusAt WHERE status IN ('awaiting-approval', 'finished');`,
];

const BOOLEANS = new Set(['assigned', 'pool', 'snoozed', 'released', 'approvalHeld']);
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

/** A row's stored value as the log keeps it: booleans and lists as in the model, long text clipped, prompts and contexts as `true`. */
function loggedValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (OMITTED.has(key)) {
    return true;
  }

  const [converted] = Object.values(fromRow<Row>({ [key]: value })!);

  return typeof converted === 'string' && converted.length > LOGGED_TEXT ? `${converted.slice(0, LOGGED_TEXT)}…` : converted;
}

/** Logged fields that differ between two stored rows; `before` null for an insert. */
function diff(table: string, before: Row | null, after: Row): Record<string, [unknown, unknown]> {
  const fields: Record<string, [unknown, unknown]> = {};

  for (const [key, value] of Object.entries(after)) {
    if (key === 'id' || UNLOGGED[table]!.has(key)) {
      continue;
    }

    const old = before === null ? null : (before[key] ?? null);

    if (old !== (value ?? null)) {
      fields[key] = [loggedValue(key, old), loggedValue(key, value)];
    }
  }

  return fields;
}

/** Clips the long texts of an event's detail. */
function loggedDetail(detail: Record<string, unknown> | null): string | null {
  if (detail === null) {
    return null;
  }

  return JSON.stringify(detail, (_key, value: unknown) => (typeof value === 'string' && value.length > LOGGED_TEXT ? `${value.slice(0, LOGGED_TEXT)}…` : value));
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

/** A triage without its context, which History does not show. */
export type HistoryTriage = Omit<Triage, 'context'>;

/** Who caused an event (PRD R59). */
export type Actor = 'operator' | 'session' | 'source' | 'triage' | 'hub';

/** A flow event as the activity log records it, before it has an ID. */
export interface EventRecord {
  at: number;
  /** The flow event's type, or `wake` for snoozes that ended before it. */
  type: string;
  actor: Actor;
  /** The ticket, work item and session the event names, when it names one. */
  ticketId: number | null;
  workItemId: number | null;
  sessionId: string | null;
  /** The event's own fields, without prompts, contexts or polled lists. */
  detail: Record<string, unknown> | null;
}

export type ChangeEntity = 'ticket' | 'workItem' | 'session' | 'triage' | 'worktree' | 'link' | 'paste';

/** One row an event wrote. `fields` maps each changed field to its old and new value; an insert's old values are null. */
export interface HistoryChange {
  entity: ChangeEntity;
  entityId: string;
  op: 'insert' | 'update' | 'delete';
  workItemId: number | null;
  sessionId: string | null;
  fields: Record<string, [unknown, unknown]>;
}

export interface HistoryEvent extends EventRecord {
  id: number;
  refused: string | null;
  /** Only the changes to this ticket's rows. */
  changes: HistoryChange[];
}

/** Everything recorded about a ticket, for History (PRD R59). */
export interface TicketHistory {
  ticket: Ticket;
  /** Newest first, each with its sessions, triages and pastes oldest first; no task or approval prompt. */
  workItems: (Omit<WorkItem, 'taskPrompt' | 'approvalPrompt'> & { sessions: Session[]; triages: HistoryTriage[]; pastes: Paste[] })[];
  /** Pool triages no pick attached to a work item, oldest first. */
  poolTriages: HistoryTriage[];
  worktree: Worktree | null;
  links: Link[];
  /** Oldest first. */
  events: HistoryEvent[];
  /** When the activity log began; null only for a database the log never ran on. */
  recordedSince: number | null;
  /** From `historyRevision`. */
  revision: string;
}

/** Fields that change on every poll or status change; their change alone is not activity, and the event's time already says when. */
const UNLOGGED: Record<string, ReadonlySet<string>> = {
  tickets: new Set(['lastPolledAt', 'sortAt', 'scopeAt']),
  workItems: new Set(['statusAt', 'runStartedAt', 'stageAt', 'scopeAt', 'queuedAt', 'readyAt', 'orderAt']),
  sessions: new Set(['stateAt']),
  triages: new Set(),
  worktrees: new Set(),
  links: new Set(['reportedAt']),
  pastes: new Set(['reportedAt']),
};

/** Prompts and contexts: the log records that they changed, as `true`, not their text. */
const OMITTED = new Set(['taskPrompt', 'approvalPrompt', 'context']);

const ENTITIES: Record<string, ChangeEntity> = {
  tickets: 'ticket',
  workItems: 'workItem',
  sessions: 'session',
  triages: 'triage',
  worktrees: 'worktree',
  links: 'link',
  pastes: 'paste',
};

/** Longest text kept in a logged field or event detail. */
const LOGGED_TEXT = 2000;

/** All database access. The hub is the only process that opens the database. */
export class Store {
  readonly #db: DatabaseSync;
  /** The event whose writes are logged; its ID is null until it is stored. */
  #event: (EventRecord & { id: number | null }) | null = null;

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

    // A table rebuild drops a parent table, which fails with foreign keys on; each migration checks them before it commits.
    db.exec('PRAGMA foreign_keys = OFF');

    for (let next = version; next < MIGRATIONS.length; next++) {
      db.exec('BEGIN');

      try {
        db.exec(MIGRATIONS[next]!);

        if (db.prepare('PRAGMA foreign_key_check').all().length > 0) {
          throw new Error(`Schema migration ${next + 1} broke a foreign key.`);
        }

        db.exec(`PRAGMA user_version = ${next + 1}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        db.close();
        throw error;
      }
    }

    db.exec('PRAGMA foreign_keys = ON');

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

  /** Starts logging writes under `record` (PRD R59). An event is stored on its first write, or at once when `always` is set. */
  beginEvent(record: EventRecord, always = false): void {
    this.#event = { ...record, id: null };

    if (always) {
      this.#eventId();
    }
  }

  /** Adds fields to the current event's detail, such as the ticket a task report created. */
  noteEvent(detail: Record<string, unknown>): void {
    if (this.#event === null) {
      return;
    }

    this.#event.detail = { ...this.#event.detail, ...detail };

    if (this.#event.id !== null) {
      this.#db.prepare('UPDATE events SET detail = ? WHERE id = ?').run(loggedDetail(this.#event.detail), this.#event.id);
      this.#bump(this.#event.ticketId);
    }
  }

  /** Records why the current event was refused; a refusal naming no ticket is not stored, because no History shows it. */
  refuseEvent(message: string): void {
    if (this.#event?.ticketId == null) {
      return;
    }

    this.#db.prepare('UPDATE events SET refused = ? WHERE id = ?').run(message, this.#eventId());
    this.#bump(this.#event.ticketId);
  }

  endEvent(): void {
    this.#event = null;
  }

  #eventId(): number {
    const event = this.#event!;

    if (event.id === null) {
      event.id = this.#insertRaw('events', { at: event.at, type: event.type, actor: event.actor, ticketId: event.ticketId, workItemId: event.workItemId, sessionId: event.sessionId, detail: loggedDetail(event.detail) });
      this.#bump(event.ticketId);
    }

    return event.id;
  }

  /** Advances the ticket's history revision after a write to its log. */
  #bump(ticketId: number | null): void {
    if (ticketId !== null) {
      this.#db.prepare('INSERT INTO historyRevisions (ticketId, revision) VALUES (?, 1) ON CONFLICT (ticketId) DO UPDATE SET revision = revision + 1').run(ticketId);
    }
  }

  /** The ticket, work item and session a row belongs to. */
  #owner(table: string, row: Row): { ticketId: number; workItemId: number | null; sessionId: string | null } {
    const ticketOf = (workItemId: unknown) => (this.#db.prepare('SELECT ticketId FROM workItems WHERE id = ?').get(workItemId as number) as { ticketId: number }).ticketId;

    switch (table) {
      case 'tickets':
        return { ticketId: row['id'] as number, workItemId: null, sessionId: null };
      case 'workItems':
        return { ticketId: row['ticketId'] as number, workItemId: row['id'] as number, sessionId: null };
      case 'sessions':
        return { ticketId: ticketOf(row['workItemId']), workItemId: row['workItemId'] as number, sessionId: row['id'] as string };
      case 'pastes':
        return { ticketId: ticketOf(row['workItemId']), workItemId: row['workItemId'] as number, sessionId: null };
      default:
        return { ticketId: row['ticketId'] as number, workItemId: (row['workItemId'] as number | undefined) ?? null, sessionId: null };
    }
  }

  /** Logs one write of the current event; an update of unlogged fields only is not activity. Rows are as stored. */
  #log(table: string, op: HistoryChange['op'], before: Row | null, after: Row | null): void {
    if (this.#event === null) {
      return;
    }

    const fields = after === null ? {} : diff(table, before, after);

    if (op === 'update' && Object.keys(fields).length === 0) {
      return;
    }

    const row = after ?? before!;
    const owner = this.#owner(table, row);

    this.#insertRaw('changes', { eventId: this.#eventId(), ...owner, entity: ENTITIES[table]!, entityId: String(row['id']), op, fields: JSON.stringify(fields) });
    this.#bump(owner.ticketId);
  }

  #raw(table: string, id: number | string): Row | null {
    return (this.#db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined) ?? null;
  }

  #insertRaw(table: string, values: Record<string, SQLInputValue>): number {
    const keys = Object.keys(values);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((key) => `:${key}`).join(', ')})`;

    return Number(this.#db.prepare(sql).run(values).lastInsertRowid);
  }

  #insert(table: string, values: Row): number {
    const params = toParams(values);
    const id = this.#insertRaw(table, params);

    this.#log(table, 'insert', null, { ...params, id: params['id'] ?? id });

    return id;
  }

  #update(table: string, id: number | string, patch: Row): void {
    const keys = Object.keys(patch);

    if (keys.length === 0) {
      return;
    }

    const before = this.#event === null ? null : this.#raw(table, id);
    const params = toParams(patch);
    const sql = `UPDATE ${table} SET ${keys.map((key) => `${key} = :${key}`).join(', ')} WHERE id = :id`;
    const result = this.#db.prepare(sql).run({ ...params, id });

    if (result.changes !== 1) {
      throw new Error(`No ${table} row with id ${id}.`);
    }

    if (before !== null) {
      this.#log(table, 'update', before, { ...before, ...params });
    }
  }

  /** Runs an upsert on a row found by `key`, and logs it as an insert or an update. */
  #upsert(table: string, sql: string, values: Row, key: string[]): void {
    const where = key.map((column) => `${column} = :${column}`).join(' AND ');
    const params = toParams(values);
    const find = () => (this.#db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(Object.fromEntries(key.map((column) => [column, params[column]!]))) as Row | undefined) ?? null;
    const before = find();

    this.#db.prepare(sql).run(params);
    this.#log(table, before === null ? 'insert' : 'update', before, find());
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

  /** The assigned or pool ticket with this URL, ignoring case, as a GitHub URL's owner and repository do. */
  ticketInScopeByUrl(url: string): Ticket | null {
    return this.#one("SELECT * FROM tickets WHERE url <> '' AND url = ? COLLATE NOCASE AND (assigned = 1 OR pool = 1) ORDER BY id LIMIT 1", url);
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

  /** Deletes a work item with its triages, sessions, pastes and activity, so History does not show it (PRD R10, R76); its children keep no parent. */
  deleteWorkItem(id: number): void {
    this.#bump(this.workItem(id)?.ticketId ?? null);

    const triageIds = JSON.stringify(this.#all<{ id: number }>('SELECT id FROM triages WHERE workItemId = ?', id).map((triage) => triage.id));

    // A pick attaches pool triages logged before the work item existed, so their activity is found by triage too.
    this.#db
      .prepare("DELETE FROM changes WHERE workItemId = :id OR (entity = 'triage' AND CAST(entityId AS INTEGER) IN (SELECT value FROM json_each(:triageIds)))")
      .run({ id, triageIds });
    this.#db
      .prepare(
        'DELETE FROM events WHERE (workItemId = :id OR json_extract(detail, \'$.triageId\') IN (SELECT value FROM json_each(:triageIds))) AND id NOT IN (SELECT eventId FROM changes)',
      )
      .run({ id, triageIds });

    if (this.#event?.id != null && this.#raw('events', this.#event.id) === null) {
      this.#event.id = null;
    }

    this.#db.prepare('DELETE FROM triages WHERE workItemId = ?').run(id);
    this.#db.prepare('DELETE FROM sessions WHERE workItemId = ?').run(id);
    this.#db.prepare('DELETE FROM pastes WHERE workItemId = ?').run(id);
    this.#db.prepare('UPDATE workItems SET parentId = NULL WHERE parentId = ?').run(id);
    this.#db.prepare('DELETE FROM workItems WHERE id = ?').run(id);
  }

  workItemsForTicket(ticketId: number): WorkItem[] {
    return this.#all('SELECT * FROM workItems WHERE ticketId = ? ORDER BY id', ticketId);
  }

  /** Work items created by task reports from the sessions of `parentId` (PRD R68). */
  workItemsWithParent(parentId: number): WorkItem[] {
    return this.#all('SELECT * FROM workItems WHERE parentId = ? ORDER BY id', parentId);
  }

  /** Open work items that have been ready for review, snoozed and blocked ones included, in Ready for review's order (PRD R27, R73). */
  readyWorkItems(): WorkItem[] {
    return this.#all("SELECT * FROM workItems WHERE status <> 'done' AND readyAt IS NOT NULL ORDER BY COALESCE(orderAt, readyAt), id");
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
    const before = this.#raw('triages', id);

    this.#db.prepare('DELETE FROM triages WHERE id = ?').run(id);

    if (before !== null) {
      this.#log('triages', 'delete', before, null);
    }
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
    this.#upsert(
      'worktrees',
      'INSERT INTO worktrees (ticketId, path, branch, linkedBy) VALUES (:ticketId, :path, :branch, :linkedBy) ' +
        'ON CONFLICT (ticketId) DO UPDATE SET path = excluded.path, branch = excluded.branch, linkedBy = excluded.linkedBy',
      worktree as unknown as Row,
      ['ticketId'],
    );
  }

  /** Adds a link to the ticket; a link to the same target replaces its label. */
  addLink(link: Omit<Link, 'id'>): void {
    this.#upsert(
      'links',
      'INSERT INTO links (ticketId, label, target, reportedAt) VALUES (:ticketId, :label, :target, :reportedAt) ' +
        'ON CONFLICT (ticketId, target) DO UPDATE SET label = excluded.label, reportedAt = excluded.reportedAt',
      link as unknown as Row,
      ['ticketId', 'target'],
    );
  }

  linksFor(ticketId: number): Link[] {
    return this.#all('SELECT * FROM links WHERE ticketId = ? ORDER BY id', ticketId);
  }

  /** Adds a paste to the work item; a paste with the same label replaces its file and keeps its place. */
  setPaste(paste: Omit<Paste, 'id'>): void {
    this.#upsert(
      'pastes',
      'INSERT INTO pastes (workItemId, label, file, reportedAt) VALUES (:workItemId, :label, :file, :reportedAt) ' +
        'ON CONFLICT (workItemId, label) DO UPDATE SET file = excluded.file, reportedAt = excluded.reportedAt',
      paste as unknown as Row,
      ['workItemId', 'label'],
    );
  }

  pastesFor(workItemId: number): Paste[] {
    return this.#all('SELECT * FROM pastes WHERE workItemId = ? ORDER BY id', workItemId);
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

  /** The latest session with this Claude session ID. */
  sessionByNativeId(nativeSessionId: string): Session | null {
    return this.#one('SELECT * FROM sessions WHERE nativeSessionId = ? ORDER BY startedAt DESC, rowid DESC LIMIT 1', nativeSessionId);
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

  /** The ticket's history revision, which every write to its log advances, deletions too; `0` for none. */
  historyRevision(ticketId: number): string {
    return String(this.#one<{ revision: number }>('SELECT revision FROM historyRevisions WHERE ticketId = ?', ticketId)?.revision ?? 0);
  }

  /** When the activity log began; earlier work shows only as the facts its migration reconstructed. */
  recordedSince(): number | null {
    return this.#one<{ at: number }>("SELECT at FROM events WHERE type = 'recording' ORDER BY id LIMIT 1")?.at ?? null;
  }

  /** The ticket's rows and its activity log; null for an unknown ticket. */
  ticketHistory(ticketId: number): TicketHistory | null {
    const ticket = this.ticket(ticketId);

    if (ticket === null) {
      return null;
    }

    const triages = this.#all<Triage>('SELECT * FROM triages WHERE ticketId = ? ORDER BY startedAt, id', ticketId).map(({ context: _context, ...triage }) => triage);
    const workItems = this.#all<WorkItem>('SELECT * FROM workItems WHERE ticketId = ? ORDER BY id DESC', ticketId).map(({ taskPrompt: _task, approvalPrompt: _approval, ...item }) => ({
      ...item,
      sessions: this.sessionsFor(item.id),
      triages: triages.filter((triage) => triage.workItemId === item.id),
      pastes: this.pastesFor(item.id),
    }));
    const changes = new Map<number, HistoryChange[]>();

    for (const row of this.#db.prepare('SELECT * FROM changes WHERE ticketId = ? ORDER BY id').all(ticketId) as Row[]) {
      const change: HistoryChange = {
        entity: row['entity'] as ChangeEntity,
        entityId: row['entityId'] as string,
        op: row['op'] as HistoryChange['op'],
        workItemId: row['workItemId'] as number | null,
        sessionId: row['sessionId'] as string | null,
        fields: JSON.parse(row['fields'] as string) as HistoryChange['fields'],
      };

      changes.set(row['eventId'] as number, [...(changes.get(row['eventId'] as number) ?? []), change]);
    }

    const events = (
      this.#db
        .prepare('SELECT * FROM events WHERE ticketId = :ticketId OR id IN (SELECT eventId FROM changes WHERE ticketId = :ticketId) ORDER BY at, id')
        .all({ ticketId }) as Row[]
    ).map(
      (row): HistoryEvent => ({
        id: row['id'] as number,
        at: row['at'] as number,
        type: row['type'] as string,
        actor: row['actor'] as Actor,
        ticketId: row['ticketId'] as number | null,
        workItemId: row['workItemId'] as number | null,
        sessionId: row['sessionId'] as string | null,
        detail: row['detail'] === null ? null : (JSON.parse(row['detail'] as string) as Record<string, unknown>),
        refused: row['refused'] as string | null,
        changes: changes.get(row['id'] as number) ?? [],
      }),
    );

    return {
      ticket,
      workItems,
      poolTriages: triages.filter((triage) => triage.workItemId === null),
      worktree: this.worktreeFor(ticketId),
      links: this.linksFor(ticketId),
      events,
      recordedSince: this.recordedSince(),
      revision: this.historyRevision(ticketId),
    };
  }
}
