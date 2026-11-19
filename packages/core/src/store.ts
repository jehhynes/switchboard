import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Comment, Link, Paste, Session, Ticket, Triage, WorkItem, WorkItemStatus, Worktree } from './model.js';
import { ownPrompt } from './group.js';
import { CONVERSATION_RETENTION } from './conversation.js';
import type { ConversationMessage, ConversationReply, TranscriptCheckpoint, WindowBinding } from './conversation.js';

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
  // Turning a source on and off is state, not configuration, so it is kept here rather than in settings.json (PRD R3).
  `CREATE TABLE sourceStates (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL);`,
  // A release stop sent and not yet finished: the session is not the operator's to open yet (PRD R39).
  `ALTER TABLE sessions ADD COLUMN releasing INTEGER NOT NULL DEFAULT 0;`,
  // A Codex session's question, as JSON, which it waits on after its turn (PRD R70).
  `ALTER TABLE sessions ADD COLUMN question TEXT;`,
  // The operator's guidance from Start, for the next task session (PRD R77).
  `ALTER TABLE workItems ADD COLUMN guidance TEXT;`,
  // The URL triage chose as the work item's focus (PRD R79).
  `ALTER TABLE triages ADD COLUMN focus TEXT;`,
  // Forks (PRD R78): the native IDs a fork retired, and the short ID of a fork waiting for the background process's release.
  `ALTER TABLE sessions ADD COLUMN retiredIds TEXT NOT NULL DEFAULT '';
  ALTER TABLE sessions ADD COLUMN pendingFork TEXT;`,
  // A session the operator registered from their own window, until it ends (PRD R81).
  `ALTER TABLE sessions ADD COLUMN external INTEGER NOT NULL DEFAULT 0;`,
  // The ad-hoc key of a ticket a ticket report moved to a source (PRD R83).
  `ALTER TABLE tickets ADD COLUMN adhocKey TEXT;`,
  `ALTER TABLE tickets ADD COLUMN inQueue INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tickets ADD COLUMN assigneeId TEXT;
   ALTER TABLE sourceStates ADD COLUMN volumeStartedAt INTEGER;
   ALTER TABLE sourceStates ADD COLUMN volumeLastAt INTEGER;
   ALTER TABLE sourceStates ADD COLUMN volumeInterval INTEGER;
   ALTER TABLE sourceStates ADD COLUMN volumeTimezone TEXT NOT NULL DEFAULT 'America/New_York';
   CREATE INDEX currentQueue ON tickets(source, inQueue, assigned, pool);`,
  `CREATE TABLE ticketClassifications (
    ticketId INTEGER PRIMARY KEY, playbook TEXT NOT NULL, immediacy TEXT, severity TEXT, at INTEGER NOT NULL
  );
  INSERT INTO ticketClassifications
    SELECT t.ticketId, t.playbook, t.immediacy, t.severity, t.endedAt FROM triages t
    JOIN tickets k ON k.id = t.ticketId
    WHERE k.source IN ('zoho', 'forum') AND t.id = (
      SELECT id FROM triages WHERE ticketId = t.ticketId AND playbook IS NOT NULL AND error IS NULL AND endedAt IS NOT NULL
      ORDER BY endedAt DESC, id DESC LIMIT 1
    );`,
  `ALTER TABLE tickets ADD COLUMN handledAssignmentKey TEXT;`,
  // Links triage found in a Zoho or Forum ticket's text and no session reported (PRD R61).
  `ALTER TABLE links ADD COLUMN mentioned INTEGER NOT NULL DEFAULT 0;
  UPDATE links SET mentioned = 1
    WHERE ticketId IN (SELECT id FROM tickets WHERE source IN ('zoho', 'forum'))
    AND EXISTS (SELECT 1 FROM changes c JOIN events e ON e.id = c.eventId
      WHERE c.entity = 'link' AND c.op = 'insert' AND c.entityId = CAST(links.id AS TEXT) AND e.type = 'triage-succeeded')
    AND NOT EXISTS (SELECT 1 FROM events e
      WHERE e.ticketId = links.ticketId AND e.type = 'report' AND e.refused IS NULL AND json_extract(e.detail, '$.kind') = 'link' AND json_extract(e.detail, '$.target') = links.target);`,
  // A triage that could not start left no triage row; one marks the failed work item as failed at triage, so Retry triages it again (PRD R34).
  // Such a work item's logged status last went from triaging to failed, or, failing before the log or any triage result, it has no playbook or prompt.
  `INSERT INTO triages (ticketId, workItemId, startedAt, endedAt, error)
    SELECT w.ticketId, w.id, w.statusAt, w.statusAt, COALESCE(w.error, 'Triage failed.') FROM workItems w JOIN tickets k ON k.id = w.ticketId
    WHERE w.status = 'failed' AND k.source NOT IN ('adhoc', 'schedule')
      AND NOT EXISTS (SELECT 1 FROM triages t WHERE t.id = (SELECT MAX(id) FROM triages WHERE workItemId = w.id) AND t.error IS NOT NULL)
      AND (
        (SELECT json_extract(c.fields, '$.status[0]') FROM changes c
          WHERE c.entity = 'workItem' AND c.workItemId = w.id AND json_type(c.fields, '$.status') IS NOT NULL ORDER BY c.id DESC LIMIT 1) = 'triaging'
        OR (w.playbook IS NULL AND w.taskPrompt IS NULL)
      );`,
  // The snooze's comment (PRD R49) and the operator's comments on work items (PRD R87); the comment and snooze events' details log the text.
  `ALTER TABLE tickets ADD COLUMN snoozeComment TEXT;
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY,
    workItemId INTEGER NOT NULL REFERENCES workItems(id),
    at INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX commentsByWorkItem ON comments (workItemId);`,
  // A task report's prompt, which identifies a repeated report after Start with prompt… edits taskPrompt (PRD R68, R77).
  `ALTER TABLE workItems ADD COLUMN reportedPrompt TEXT;
  UPDATE workItems SET reportedPrompt = taskPrompt WHERE parentId IS NOT NULL;`,
  // Continue in Background (PRD R89): the move under way, as JSON, and when the last one ended.
  `ALTER TABLE sessions ADD COLUMN move TEXT;
  ALTER TABLE sessions ADD COLUMN movedAt INTEGER;`,
  // The open issues blocking a ticket, as JSON (PRD R90).
  `ALTER TABLE tickets ADD COLUMN blockers TEXT NOT NULL DEFAULT '[]';`,
  // A ticket's repository (PRD R44); empty is the source's home repository, which cannot change while the source has tickets.
  `ALTER TABLE tickets ADD COLUMN repo TEXT NOT NULL DEFAULT '';`,
  // The home repository of each source with tickets, which bare keys mean (PRD R44), kept even when every stored key is qualified.
  `CREATE TABLE sourceHomes (source TEXT PRIMARY KEY, repo TEXT NOT NULL);`,
  // Code Mode sessions (PRD R93): the mode a session started in, and the launch of its current process.
  `ALTER TABLE sessions ADD COLUMN codeMode INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN launchId TEXT;`,
  // The process tree a Code Mode session's holder last listed, as JSON, which the resume guard checks (PRD R95).
  `ALTER TABLE sessions ADD COLUMN lastTree TEXT;`,
  // The conversation rules version a Code Mode session's prompt carries (architecture.md § Conversation).
  `ALTER TABLE sessions ADD COLUMN rulesVersion INTEGER;`,
  // A Code Mode session's conversation, its transcript readers' checkpoints and the windows' work items (architecture.md § Conversation).
  `CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Shared with replies, so items written at the same time keep the order they were added in.
    ord INTEGER NOT NULL,
    id TEXT NOT NULL UNIQUE,
    sessionId TEXT NOT NULL,
    workItemId INTEGER,
    at INTEGER NOT NULL,
    origin TEXT NOT NULL,
    text TEXT NOT NULL,
    transcriptUuid TEXT
  );
  CREATE INDEX messagesBySession ON messages (sessionId, at);
  CREATE INDEX messagesByOrd ON messages (ord);
  CREATE TABLE replies (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ord INTEGER NOT NULL,
    id TEXT NOT NULL UNIQUE,
    sessionId TEXT NOT NULL,
    workItemId INTEGER,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    answers TEXT,
    opening TEXT NOT NULL,
    source TEXT NOT NULL,
    replaces TEXT,
    rewrittenBy TEXT,
    withdrawn INTEGER NOT NULL DEFAULT 0,
    transcriptUuid TEXT
  );
  CREATE INDEX repliesBySession ON replies (sessionId, at);
  CREATE INDEX repliesByOrd ON replies (ord);
  CREATE TABLE checkpoints (
    sessionId TEXT PRIMARY KEY,
    transcript TEXT NOT NULL,
    offset INTEGER NOT NULL,
    lastUuid TEXT,
    lastAt INTEGER
  );
  CREATE TABLE windowBindings (
    file TEXT PRIMARY KEY,
    workItemId INTEGER,
    since INTEGER NOT NULL,
    scopeGen INTEGER NOT NULL
  );`,
  // A message sent while the session was busy, until the transcript line where Claude received it is read, and one it never received as one.
  `ALTER TABLE messages ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN withdrawn INTEGER NOT NULL DEFAULT 0;
  -- The API message a reply was read from, and its text lines, which Claude Code writes one per content block, so a later line joins it.
  ALTER TABLE replies ADD COLUMN apiMessageId TEXT;
  ALTER TABLE replies ADD COLUMN blocks TEXT;`,
  // Messages typed from the view (architecture.md § Typing a message): their delivery, why one failed, and the command that sent it.
  `ALTER TABLE messages ADD COLUMN delivery TEXT;
  ALTER TABLE messages ADD COLUMN error TEXT;
  ALTER TABLE messages ADD COLUMN opId TEXT;
  ALTER TABLE messages ADD COLUMN pastedAt INTEGER;
  CREATE INDEX messagesByOpId ON messages (opId);`,
];

/**
 * An item's place in a session's conversation (`inTranscript`): 0 once its transcript line was read, then `ord`. A withdrawn item, which no
 * view shows, counts as read, so it is pruned in turn and never holds the items after it.
 */
const MESSAGE_PLACE = '(provisional = 1 AND withdrawn = 0)';
const REPLY_PLACE = "(source = 'screen' AND withdrawn = 0)";

const BOOLEANS = new Set(['assigned', 'pool', 'inQueue', 'snoozed', 'released', 'releasing', 'approvalHeld', 'external', 'mentioned', 'codeMode']);
/** Stored as comma-separated text. */
const LISTS = new Set(['reports', 'retiredIds']);
/** Stored as JSON text. */
const OBJECTS = new Set(['question', 'move', 'blockers', 'lastTree']);

type Row = Record<string, unknown>;

function fromRow<T>(row: Row | undefined): T | null {
  if (row === undefined) {
    return null;
  }

  const result: Row = {};

  for (const [key, value] of Object.entries(row)) {
    result[key] = BOOLEANS.has(key) ? value === 1 : LISTS.has(key) ? String(value).split(',').filter((entry) => entry !== '') : OBJECTS.has(key) && typeof value === 'string' ? JSON.parse(value) : value;
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
    result[key] = typeof value === 'boolean' ? (value ? 1 : 0) : OBJECTS.has(key) && value !== null ? JSON.stringify(value) : Array.isArray(value) ? value.join(',') : (value as SQLInputValue);
  }

  return result;
}

export type NewTicket = Omit<Ticket, 'id' | 'adhocKey' | 'repo'> & { adhocKey?: string | null; repo?: string };
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
  /**
   * `prompted`: the work item has a task prompt, which a registered session's lacks (PRD R81); `prompt`: the prompt of an ad-hoc or task work
   * item, which has no ticket elsewhere to show it (PRD R59).
   */
  workItems: (Omit<WorkItem, 'taskPrompt' | 'approvalPrompt' | 'reportedPrompt'> & { prompted: boolean; prompt: string | null; sessions: Session[]; triages: HistoryTriage[]; pastes: Paste[] })[];
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
  // The snooze event's detail holds its comment (PRD R49).
  tickets: new Set(['lastPolledAt', 'sortAt', 'scopeAt', 'snoozeComment']),
  // The start or pick event's detail holds the guidance (PRD R77).
  workItems: new Set(['statusAt', 'runStartedAt', 'stageAt', 'scopeAt', 'queuedAt', 'readyAt', 'orderAt', 'guidance', 'reportedPrompt']),
  // The question report's event names the question; its ID and its clearing are bookkeeping. A fork's nativeSessionId change names what it retired.
  // The register event names an external session, and its end already shows when it was cleared.
  // The background event and its result name a move (PRD R89); its fields are bookkeeping.
  // The session-started event names a Code Mode session; its launch and last process tree are bookkeeping (PRD R93, R95).
  sessions: new Set(['stateAt', 'releasing', 'question', 'retiredIds', 'external', 'move', 'movedAt', 'codeMode', 'launchId', 'lastTree', 'rulesVersion']),
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

  /**
   * Opens the database for reading only, as the hub's snapshot worker does (architecture.md § Hub lifecycle); the hub's own connection has
   * migrated it, so a schema of another version is refused.
   */
  static openReadOnly(path: string): Store {
    const { DatabaseSync: Database } = process.getBuiltinModule('node:sqlite');
    const db = new Database(path, { readOnly: true });

    db.exec('PRAGMA busy_timeout = 5000;');

    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

    if (version !== MIGRATIONS.length) {
      db.close();
      throw new Error(`The database is schema version ${version}, not ${MIGRATIONS.length}.`);
    }

    return new Store(db);
  }

  close(): void {
    this.#db.close();
  }

  /** Runs `fn` in one read transaction, so every query sees the same committed state, as the snapshot worker's build needs. */
  readTransaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN');

    try {
      return fn();
    } finally {
      this.#db.exec('COMMIT');
    }
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
    const row = { adhocKey: null, repo: '', inQueue: false, assigneeId: null, handledAssignmentKey: null, snoozeComment: null, blockers: [], ...ticket };

    return { id: this.#insert('tickets', row as unknown as Row), ...row };
  }

  /**
   * Deletes a ticket that has no work item, triage, worktree or link, with its activity, such as one a poll stored before a ticket report
   * moved an ad-hoc ticket to the same key (PRD R83).
   */
  deleteBareTicket(id: number): void {
    if (this.ticket(id)?.handledAssignmentKey != null) throw new Error(`Ticket ${id} has a handled assignment.`);
    const held = this.#db
      .prepare('SELECT (SELECT COUNT(*) FROM workItems WHERE ticketId = :id) + (SELECT COUNT(*) FROM triages WHERE ticketId = :id) + (SELECT COUNT(*) FROM worktrees WHERE ticketId = :id) + (SELECT COUNT(*) FROM links WHERE ticketId = :id) AS n')
      .get({ id }) as { n: number };

    if (held.n > 0) {
      throw new Error(`Ticket ${id} has work items, triages, a worktree or links.`);
    }

    this.#db.prepare('DELETE FROM changes WHERE ticketId = ?').run(id);
    this.#db.prepare('DELETE FROM events WHERE ticketId = ?').run(id);
    this.#db.prepare('DELETE FROM historyRevisions WHERE ticketId = ?').run(id);
    this.#db.prepare('DELETE FROM ticketClassifications WHERE ticketId = ?').run(id);
    this.#db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  }

  /** Every ad-hoc key in use, including those of tickets a ticket report moved to a source (PRD R83). */
  adhocKeys(): string[] {
    return (this.#db.prepare("SELECT sourceKey AS key FROM tickets WHERE source = 'adhoc' UNION SELECT adhocKey FROM tickets WHERE adhocKey IS NOT NULL").all() as { key: string }[]).map((row) => row.key);
  }

  /** The repositories each source's tickets record, without the empty home repository (PRD R44). */
  reposBySource(): Record<string, string[]> {
    const rows = this.#db.prepare("SELECT DISTINCT source, repo FROM tickets WHERE repo != '' ORDER BY source, repo").all() as { source: string; repo: string }[];
    const repos: Record<string, string[]> = {};

    for (const row of rows) {
      (repos[row.source] ??= []).push(row.repo);
    }

    return repos;
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

  /**
   * The home repository each source's tickets record: the repository of a ticket with a bare key, which only the home repository's issues
   * have (PRD R44). A source whose tickets record none is absent.
   */
  homeRepos(): Record<string, string> {
    const rows = this.#db
      .prepare("SELECT source, repo FROM sourceHomes UNION SELECT source, MIN(repo) FROM tickets WHERE repo != '' AND instr(sourceKey, '#') = 0 AND source NOT IN (SELECT source FROM sourceHomes) GROUP BY source")
      .all() as { source: string; repo: string }[];

    return Object.fromEntries(rows.map((row) => [row.source, row.repo]));
  }

  /**
   * Records `repo` as the source's home repository once it has tickets, and on its bare-key tickets that record none, as tickets stored before
   * migration 38 do. A home already recorded is kept.
   */
  fillHomeRepo(source: string, repo: string): void {
    this.#db.prepare("UPDATE tickets SET repo = ? WHERE source = ? AND repo = '' AND instr(sourceKey, '#') = 0").run(repo, source);
    this.#db.prepare('INSERT OR IGNORE INTO sourceHomes (source, repo) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM tickets WHERE source = ?)').run(source, repo, source);
  }

  /** The ticket with this URL in any source, ignoring case, as a GitHub URL's owner and repository do; the oldest when several. */
  ticketByUrl(url: string): Ticket | null {
    return this.#one("SELECT * FROM tickets WHERE url <> '' AND url = ? COLLATE NOCASE ORDER BY id LIMIT 1", url);
  }

  /** Each source's repositories with a ticket that is assigned, in the pool or registered, for worktree linking (PRD R25). */
  openRepos(source: string): string[] {
    return (this.#db.prepare('SELECT DISTINCT repo FROM tickets WHERE source = ? AND (assigned = 1 OR pool = 1 OR handledAssignmentKey IS NOT NULL) ORDER BY repo').all(source) as { repo: string }[]).map((row) => row.repo);
  }

  tickets(source: string): Ticket[] {
    return this.#all('SELECT * FROM tickets WHERE source = ? ORDER BY id', source);
  }

  currentTickets(source: string): Ticket[] {
    return this.#all('SELECT * FROM tickets WHERE source = ? AND (inQueue = 1 OR assigned = 1 OR pool = 1) ORDER BY id', source);
  }

  volumePoll(source: string, at: number, interval: number): void {
    const previous = this.#one<{ volumeLastAt: number | null; volumeInterval: number | null }>('SELECT volumeLastAt, volumeInterval FROM sourceStates WHERE name = ?', source);
    if (previous?.volumeLastAt != null && at - previous.volumeLastAt > 3 * (previous.volumeInterval ?? interval)) {
      this.#db.prepare("INSERT INTO events(at, type, actor, detail) VALUES (?, 'volume-gap', 'hub', ?)").run(at, JSON.stringify({ source, from: previous.volumeLastAt, to: at }));
    }
    this.#db.prepare(`INSERT INTO sourceStates(name, enabled, volumeStartedAt, volumeLastAt, volumeInterval) VALUES (?, 1, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET volumeStartedAt = COALESCE(volumeStartedAt, excluded.volumeStartedAt), volumeLastAt = excluded.volumeLastAt, volumeInterval = excluded.volumeInterval`).run(source, at, at, interval);
  }

  volumeWorked(ticketId: number, sessionId: string, at: number): void {
    this.#db.prepare("INSERT INTO events(at, type, actor, ticketId, detail) VALUES (?, 'volume-worked', 'hub', ?, ?)").run(at, ticketId, JSON.stringify({ sessionId }));
    this.#bump(ticketId);
  }

  /** Ticket-report identity consolidation preserves queue evidence on the surviving ticket. */
  transferVolume(from: number, to: number): void {
    this.#db.prepare(`INSERT INTO ticketClassifications SELECT ?, playbook, immediacy, severity, at FROM ticketClassifications WHERE ticketId = ?
      ON CONFLICT(ticketId) DO UPDATE SET playbook = excluded.playbook, immediacy = excluded.immediacy, severity = excluded.severity, at = excluded.at
      WHERE excluded.at > ticketClassifications.at`).run(to, from);
    const ticket = this.ticket(from)!;
    this.#db.prepare("UPDATE changes SET ticketId = ?, entityId = CASE WHEN entity = 'ticket' THEN ? ELSE entityId END WHERE ticketId = ?").run(to, String(to), from);
    this.#db.prepare('UPDATE events SET ticketId = ? WHERE ticketId = ?').run(to, from);
    this.#db.prepare('UPDATE tickets SET inQueue = ?, assigneeId = ? WHERE id = ?').run(ticket.inQueue ? 1 : 0, ticket.assigneeId ?? null, to);
    this.#bump(to);
  }

  volumeData(): import('./volume.js').VolumeData {
    return {
      classifications: this.#all('SELECT * FROM ticketClassifications'),
      sources: this.#db.prepare('SELECT name AS source, volumeStartedAt AS startedAt, volumeLastAt AS lastAt, volumeInterval AS interval, volumeTimezone AS timezone FROM sourceStates WHERE volumeStartedAt IS NOT NULL').all() as unknown as import('./volume.js').VolumeSource[],
      tickets: this.#all<Ticket>("SELECT * FROM tickets WHERE source IN ('zoho', 'forum')"),
      changes: this.#db.prepare(`SELECT c.ticketId, e.at, c.fields FROM changes c JOIN events e ON e.id = c.eventId JOIN tickets t ON t.id = c.ticketId
        WHERE c.entity = 'ticket' AND t.source IN ('zoho', 'forum') AND (json_type(c.fields, '$.inQueue') IS NOT NULL OR json_type(c.fields, '$.assigned') IS NOT NULL) ORDER BY e.at, c.id`).all().map((r) => ({ ticketId: r['ticketId'] as number, at: r['at'] as number, fields: JSON.parse(r['fields'] as string) as Record<string, [unknown, unknown]> })),
      worked: this.#db.prepare("SELECT ticketId, at FROM events WHERE type = 'volume-worked' ORDER BY at, id").all() as unknown as { ticketId: number; at: number }[],
      gaps: this.#db.prepare("SELECT detail FROM events WHERE type = 'volume-gap' ORDER BY at, id").all().map((r) => JSON.parse(r['detail'] as string) as { source: string; from: number; to: number }),
    };
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

  /** Deletes a work item with its triages, sessions, pastes, comments and activity, so History does not show it (PRD R10, R76); its children keep no parent. */
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
    this.#db.prepare('DELETE FROM checkpoints WHERE sessionId IN (SELECT id FROM sessions WHERE workItemId = ?)').run(id);
    this.#db.prepare('DELETE FROM messages WHERE workItemId = ?').run(id);
    this.#db.prepare('DELETE FROM replies WHERE workItemId = ?').run(id);
    this.#db.prepare('DELETE FROM sessions WHERE workItemId = ?').run(id);
    this.#db.prepare('DELETE FROM pastes WHERE workItemId = ?').run(id);
    this.#db.prepare('DELETE FROM comments WHERE workItemId = ?').run(id);
    this.#db.prepare('UPDATE workItems SET parentId = NULL WHERE parentId = ?').run(id);
    this.#db.prepare('DELETE FROM workItems WHERE id = ?').run(id);
  }

  workItemsForTicket(ticketId: number): WorkItem[] {
    return this.#all('SELECT * FROM workItems WHERE ticketId = ? ORDER BY id', ticketId);
  }

  /** Tickets with a handled assignment, of one source or of all. */
  handledTickets(source: string | null = null): Ticket[] {
    return this.#all('SELECT * FROM tickets WHERE (? IS NULL OR source = ?) AND handledAssignmentKey IS NOT NULL ORDER BY id', source, source);
  }

  /** The ticket's handled-assignment registrations in order: when, the key, and the reporting work item, which may since be deleted, and its playbook (PRD R85). */
  handledRegistrations(ticketId: number): { at: number; key: string; workItemId: number | null; playbook: string | null }[] {
    return this.#all(`SELECT e.at AS at, json_extract(e.detail, '$.key') AS key, json_extract(e.detail, '$.reportedByWorkItemId') AS workItemId,
      json_extract(e.detail, '$.reportedByPlaybook') AS playbook
      FROM events e JOIN changes c ON c.eventId = e.id WHERE c.ticketId = ? AND e.type = 'handled' AND e.refused IS NULL
      AND json_extract(c.fields, '$.handledAssignmentKey[1]') IS NOT NULL ORDER BY e.id`, ticketId);
  }

  assignmentEnded(ticketId: number, key: string): boolean {
    return this.#one(`SELECT id FROM changes WHERE entity = 'ticket' AND ticketId = ?
      AND json_extract(fields, '$.handledAssignmentKey[0]') = ?
      AND json_type(fields, '$.handledAssignmentKey[1]') = 'null' LIMIT 1`, ticketId, key) !== null;
  }

  registeredAssignment(ticketId: number, sessionId: string): string | null {
    return this.#one<{ key: string }>(`SELECT json_extract(e.detail, '$.key') AS key FROM events e
      JOIN changes c ON c.eventId = e.id WHERE c.ticketId = ? AND e.type = 'handled'
      AND json_extract(e.detail, '$.reportedBySessionId') = ? AND json_extract(e.detail, '$.release') = 0
      AND e.refused IS NULL ORDER BY e.id DESC LIMIT 1`, ticketId, sessionId)?.key ?? null;
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
    const triage = this.triage(id)!;
    if (triage.playbook !== null && triage.endedAt !== null && triage.error === null) {
      this.#db.prepare(`INSERT INTO ticketClassifications
        SELECT id, ?, ?, ?, ? FROM tickets WHERE id = ? AND source IN ('zoho', 'forum')
        ON CONFLICT(ticketId) DO UPDATE SET playbook = excluded.playbook, immediacy = excluded.immediacy, severity = excluded.severity, at = excluded.at
        WHERE excluded.at >= ticketClassifications.at`).run(triage.playbook, triage.immediacy, triage.severity, triage.endedAt, triage.ticketId);
    }
  }

  /** Retained Support tickets without a classification or an outstanding/failed ticket-only attempt. */
  unclassifiedTickets(): Ticket[] {
    return this.#all(`SELECT t.* FROM tickets t WHERE source IN ('zoho', 'forum') AND lastPolledAt IS NOT NULL
      AND assigned = 0 AND pool = 0
      AND (inQueue = 1 OR EXISTS (SELECT 1 FROM changes WHERE ticketId = t.id AND entity = 'ticket' AND json_extract(fields, '$.inQueue[1]') = 1))
      AND NOT EXISTS (SELECT 1 FROM ticketClassifications WHERE ticketId = t.id)
      AND NOT EXISTS (SELECT 1 FROM triages WHERE ticketId = t.id AND workItemId IS NULL)
      ORDER BY t.id`);
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

  /** Adds a link to the ticket; a link to the same target replaces its label, and stays unmentioned once a session reported it. */
  addLink(link: Omit<Link, 'id'>): void {
    this.#upsert(
      'links',
      'INSERT INTO links (ticketId, label, target, reportedAt, mentioned) VALUES (:ticketId, :label, :target, :reportedAt, :mentioned) ' +
        'ON CONFLICT (ticketId, target) DO UPDATE SET label = excluded.label, reportedAt = excluded.reportedAt, mentioned = MIN(mentioned, excluded.mentioned)',
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

  /** Adds the operator's comment; the comment event logs its text, so the row itself is not logged (PRD R87). */
  addComment(comment: Omit<Comment, 'id'>): void {
    this.#insertRaw('comments', comment as unknown as Record<string, SQLInputValue>);
  }

  /** Oldest first. */
  commentsFor(workItemId: number): Comment[] {
    return this.#all('SELECT * FROM comments WHERE workItemId = ? ORDER BY id', workItemId);
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

  /** Sessions moving to their background process, whatever their state, since a move can begin before the roster revives an ended one (PRD R89). */
  movingSessions(): Session[] {
    return this.#all('SELECT * FROM sessions WHERE move IS NOT NULL ORDER BY startedAt, rowid');
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

  /** The sources the operator turned on; a source with no row is off. */
  enabledSources(): Set<string> {
    return new Set((this.#db.prepare('SELECT name FROM sourceStates WHERE enabled = 1').all() as { name: string }[]).map((row) => row.name));
  }

  setSourceEnabled(name: string, enabled: boolean): void {
    this.#db.prepare('INSERT INTO sourceStates (name, enabled) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET enabled = excluded.enabled').run(name, enabled ? 1 : 0);
  }

  /** Forgets the state of every source not in `names`, so a source removed and added again starts off (PRD R3). */
  keepSourceStates(names: string[]): void {
    this.#db.prepare(`UPDATE sourceStates SET enabled = 0 WHERE name NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(names));
    this.#db.prepare(`DELETE FROM sourceStates WHERE volumeStartedAt IS NULL AND name NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(names));
  }

  /** When the activity log began; earlier work shows only as the facts its migration reconstructed. */
  recordedSince(): number | null {
    return this.#one<{ at: number }>("SELECT at FROM events WHERE type = 'recording' ORDER BY id LIMIT 1")?.at ?? null;
  }

  /** The ticket's rows and its activity log; null for an unknown ticket. */
  /** Adds a message to a session's conversation, outside the activity log, keeping the newest `CONVERSATION_RETENTION` items. */
  addMessage(message: Omit<ConversationMessage, 'ord'>): void {
    this.#db
      .prepare('INSERT INTO messages (ord, id, sessionId, workItemId, at, origin, text, transcriptUuid, provisional, withdrawn, delivery, error, opId, pastedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.#nextOrd(), message.id, message.sessionId, message.workItemId, message.at, message.origin, message.text, message.transcriptUuid, message.provisional ? 1 : 0, message.withdrawn ? 1 : 0, message.delivery, message.error, message.opId, message.pastedAt);
    this.#prune(message.sessionId);
  }

  updateMessage(id: string, patch: Partial<Pick<ConversationMessage, 'at' | 'transcriptUuid' | 'provisional' | 'withdrawn' | 'delivery' | 'error' | 'pastedAt'>>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);

    if (entries.length > 0) {
      this.#db
        .prepare(`UPDATE messages SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
        .run(...entries.map(([, value]) => (typeof value === 'boolean' ? (value ? 1 : 0) : (value as SQLInputValue))), id);
    }
  }

  /** Removes a message, as a typed message that was not sent leaves the conversation. */
  deleteMessage(id: string): void {
    this.#db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  }

  message(id: string): ConversationMessage | null {
    return this.#messageRows('SELECT * FROM messages WHERE id = ?', id)[0] ?? null;
  }

  messageByTranscriptUuid(sessionId: string, uuid: string): ConversationMessage | null {
    return this.#messageRows('SELECT * FROM messages WHERE sessionId = ? AND transcriptUuid = ?', sessionId, uuid)[0] ?? null;
  }

  /** The reply read from an API message, with the UUIDs and texts of its lines, in order. */
  replyOfApiMessage(sessionId: string, apiMessageId: string): { replyId: string; blocks: Array<{ uuid: string | null; text: string }> } | null {
    const row = this.#db.prepare('SELECT id, blocks FROM replies WHERE sessionId = ? AND apiMessageId = ? ORDER BY ord DESC LIMIT 1').get(sessionId, apiMessageId) as { id: string; blocks: string | null } | undefined;

    return row === undefined ? null : { replyId: row.id, blocks: row.blocks === null ? [] : (JSON.parse(row.blocks) as Array<{ uuid: string | null; text: string }>) };
  }

  replyBlocks(sessionId: string, limit: number): string[] {
    const rows = this.#db.prepare('SELECT blocks FROM replies WHERE sessionId = ? AND blocks IS NOT NULL ORDER BY ord DESC LIMIT ?').all(sessionId, limit) as Array<{ blocks: string }>;

    return rows.flatMap((row) => (JSON.parse(row.blocks) as Array<{ text: string }>).map((block) => block.text));
  }

  setApiMessage(replyId: string, apiMessageId: string, blocks: Array<{ uuid: string | null; text: string }>): void {
    this.#db.prepare('UPDATE replies SET apiMessageId = ?, blocks = ? WHERE id = ?').run(apiMessageId, JSON.stringify(blocks), replyId);
  }

  /** A session's sent messages not yet received, oldest first. */
  provisionalMessages(sessionId: string): ConversationMessage[] {
    return this.#messageRows('SELECT * FROM messages WHERE sessionId = ? AND provisional = 1 AND withdrawn = 0 ORDER BY ord', sessionId);
  }

  /** Moves a message or reply after every item before it, because its transcript line was just read (`inTranscript`). */
  placeLast(id: string): void {
    const ord = this.#nextOrd();

    this.#db.prepare('UPDATE messages SET ord = ? WHERE id = ?').run(ord, id);
    this.#db.prepare('UPDATE replies SET ord = ? WHERE id = ?').run(ord, id);
  }

  /** The message a `send` command with this `opId` added to the session. */
  messageByOpId(sessionId: string, opId: string): ConversationMessage | null {
    return this.#messageRows('SELECT * FROM messages WHERE sessionId = ? AND opId = ? ORDER BY ord LIMIT 1', sessionId, opId)[0] ?? null;
  }

  /** A session's typed messages that may still reach its transcript, oldest first: pasted, not `not-sent`, and not yet matched to an entry. */
  typedAwaitingTranscript(sessionId: string): ConversationMessage[] {
    return this.#messageRows("SELECT * FROM messages WHERE sessionId = ? AND origin = 'typed' AND transcriptUuid IS NULL AND pastedAt IS NOT NULL AND delivery <> 'not-sent' ORDER BY at, ord", sessionId);
  }

  /** Typed messages a stopped hub left `open`, now `uncertain` with `error`; returns them. */
  settleOpenMessages(error: string): ConversationMessage[] {
    const open = this.#messageRows("SELECT * FROM messages WHERE delivery = 'open' ORDER BY ord");

    // Settled, so it keeps its place rather than wait at the end for a transcript line (`inTranscript`).
    this.#db.prepare("UPDATE messages SET delivery = 'uncertain', error = ?, provisional = 0 WHERE delivery = 'open'").run(error);

    return open.map((message) => ({ ...message, delivery: 'uncertain', error, provisional: false }));
  }

  /** Adds a reply to a session's conversation, outside the activity log, keeping the newest `CONVERSATION_RETENTION` items. */
  addReply(reply: Omit<ConversationReply, 'ord'>): void {
    this.#db
      .prepare('INSERT INTO replies (ord, id, sessionId, workItemId, at, kind, answers, opening, source, replaces, rewrittenBy, withdrawn, transcriptUuid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.#nextOrd(), reply.id, reply.sessionId, reply.workItemId, reply.at, reply.kind, reply.answers, reply.opening, reply.source, reply.replaces, reply.rewrittenBy, reply.withdrawn ? 1 : 0, reply.transcriptUuid);
    this.#prune(reply.sessionId);
  }

  updateReply(id: string, patch: Partial<Omit<ConversationReply, 'id' | 'sessionId' | 'workItemId' | 'ord'>>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);

    if (entries.length > 0) {
      this.#db
        .prepare(`UPDATE replies SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
        .run(...entries.map(([key, value]) => (key === 'withdrawn' ? (value ? 1 : 0) : (value as SQLInputValue))), id);
    }
  }

  /** The newest message of a session that Claude received, which a reply read after a restart answers. */
  latestMessageId(sessionId: string): string | null {
    return (this.#db.prepare('SELECT id FROM messages WHERE sessionId = ? AND provisional = 0 AND withdrawn = 0 ORDER BY ord DESC LIMIT 1').get(sessionId) as { id: string } | undefined)?.id ?? null;
  }

  /** Whether a transcript entry is already in the session's conversation. */
  hasTranscriptEntry(sessionId: string, uuid: string): boolean {
    return this.#db.prepare('SELECT 1 FROM messages WHERE sessionId = :id AND transcriptUuid = :uuid UNION ALL SELECT 1 FROM replies WHERE sessionId = :id AND transcriptUuid = :uuid').get({ id: sessionId, uuid }) !== undefined;
  }

  reply(id: string): ConversationReply | null {
    return this.#replyRows('SELECT * FROM replies WHERE id = ?', id)[0] ?? null;
  }

  /** A session's newest replies, newest first; with `before`, only those before that reply in the conversation's order. */
  latestReplies(sessionId: string, limit: number, before?: string): ConversationReply[] {
    const cursor = before === undefined ? null : (this.#db.prepare(`SELECT ${REPLY_PLACE} AS place, ord FROM replies WHERE id = ?`).get(before) as { place: number; ord: number } | undefined);

    if (cursor === undefined) {
      return [];
    }

    const older = cursor === null ? '' : `AND (${REPLY_PLACE} < :place OR (${REPLY_PLACE} = :place AND ord < :ord))`;

    return this.#replyRows(`SELECT * FROM replies WHERE sessionId = :id ${older} ORDER BY ${REPLY_PLACE} DESC, ord DESC LIMIT :limit`, { id: sessionId, limit, ...(cursor === null ? {} : cursor) });
  }

  /**
   * A session's messages and replies in order (`inTranscript`), at most `limit` of the newest before the item `before`, and whether there are
   * older ones.
   */
  conversation(sessionId: string, before: string | null, limit: number, withdrawn = true): { items: Array<({ type: 'message' } & ConversationMessage) | ({ type: 'reply' } & ConversationReply)>; more: boolean } {
    // The cursor is the oldest item the reader has, by its place.
    const found =
      before === null
        ? null
        : (this.#db.prepare(`SELECT ${MESSAGE_PLACE} AS place, ord FROM messages WHERE id = :item AND sessionId = :id UNION ALL SELECT ${REPLY_PLACE} AS place, ord FROM replies WHERE id = :item AND sessionId = :id`).get({ item: before, id: sessionId }) as
            | { place: number; ord: number }
            | undefined);

    // A cursor of another session, or one retention deleted, has nothing before it.
    if (found === undefined) {
      return { items: [], more: false };
    }

    const cursor = found ?? { place: 2, ord: Number.MAX_SAFE_INTEGER };
    // A view leaves withdrawn items out before the limit, so a page of them never stops it paging back.
    const shown = withdrawn ? '' : 'AND withdrawn = 0';
    const older = (place: string) => `sessionId = :id ${shown} AND (${place} < :place OR (${place} = :place AND ord < :ord)) ORDER BY ${place} DESC, ord DESC LIMIT :limit`;
    const bind = { id: sessionId, place: cursor.place, ord: cursor.ord, limit: limit + 1 };
    const messages = this.#messageRows(`SELECT * FROM messages WHERE ${older(MESSAGE_PLACE)}`, bind);
    const replies = this.#replyRows(`SELECT * FROM replies WHERE ${older(REPLY_PLACE)}`, bind);
    const place = (item: ({ type: 'message'; provisional: boolean } | { type: 'reply'; source: string }) & { withdrawn: boolean }) =>
      item.withdrawn ? 0 : item.type === 'message' ? (item.provisional ? 1 : 0) : item.source === 'screen' ? 1 : 0;
    const merged = [...messages.map((message) => ({ type: 'message' as const, ...message })), ...replies.map((reply) => ({ type: 'reply' as const, ...reply }))].sort(
      (a, b) => place(b) - place(a) || b.ord - a.ord,
    );

    return { items: merged.slice(0, limit).reverse(), more: merged.length > limit };
  }

  checkpoint(sessionId: string): TranscriptCheckpoint | null {
    return (this.#db.prepare('SELECT * FROM checkpoints WHERE sessionId = ?').get(sessionId) as TranscriptCheckpoint | undefined) ?? null;
  }

  setCheckpoint(checkpoint: TranscriptCheckpoint): void {
    this.#db
      .prepare('INSERT INTO checkpoints (sessionId, transcript, offset, lastUuid, lastAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT (sessionId) DO UPDATE SET transcript = excluded.transcript, offset = excluded.offset, lastUuid = excluded.lastUuid, lastAt = excluded.lastAt')
      .run(checkpoint.sessionId, checkpoint.transcript, checkpoint.offset, checkpoint.lastUuid, checkpoint.lastAt);
  }

  windowBinding(file: string): WindowBinding | null {
    return (this.#db.prepare('SELECT * FROM windowBindings WHERE file = ?').get(file) as WindowBinding | undefined) ?? null;
  }

  setWindowBinding(binding: WindowBinding): void {
    this.#db
      .prepare('INSERT INTO windowBindings (file, workItemId, since, scopeGen) VALUES (?, ?, ?, ?) ON CONFLICT (file) DO UPDATE SET workItemId = excluded.workItemId, since = excluded.since, scopeGen = excluded.scopeGen')
      .run(binding.file, binding.workItemId, binding.since, binding.scopeGen);
  }

  #replyRows(sql: string, ...params: Array<SQLInputValue | Record<string, SQLInputValue>>): ConversationReply[] {
    return (this.#db.prepare(sql).all(...(params as SQLInputValue[])) as unknown as Array<Omit<ConversationReply, 'withdrawn'> & { seq: number; withdrawn: number | boolean; apiMessageId?: unknown; blocks?: unknown }>).map(({ seq: _seq, apiMessageId: _api, blocks: _blocks, ...reply }) => ({
      ...reply,
      withdrawn: reply.withdrawn === 1 || reply.withdrawn === true,
    }));
  }

  #messageRows(sql: string, ...params: Array<SQLInputValue | Record<string, SQLInputValue>>): ConversationMessage[] {
    return (this.#db.prepare(sql).all(...(params as SQLInputValue[])) as unknown as Array<Omit<ConversationMessage, 'provisional' | 'withdrawn'> & { seq: number; provisional: number; withdrawn: number }>).map(({ seq: _seq, ...message }) => ({
      ...message,
      provisional: message.provisional === 1,
      withdrawn: message.withdrawn === 1,
    }));
  }

  #nextOrd(): number {
    const row = this.#db.prepare('SELECT MAX(COALESCE((SELECT MAX(ord) FROM messages), 0), COALESCE((SELECT MAX(ord) FROM replies), 0)) AS ord').get() as { ord: number };

    return row.ord + 1;
  }

  /** Deletes a session's items beyond the newest `CONVERSATION_RETENTION`, counting messages and replies together. */
  #prune(sessionId: string): void {
    // The oldest item kept; everything before it, by place, goes.
    const kept = this.#db
      .prepare(
        `SELECT place, ord FROM (SELECT ${MESSAGE_PLACE} AS place, ord FROM messages WHERE sessionId = :id UNION ALL SELECT ${REPLY_PLACE} AS place, ord FROM replies WHERE sessionId = :id) ORDER BY place DESC, ord DESC LIMIT 1 OFFSET :offset`,
      )
      .get({ id: sessionId, offset: CONVERSATION_RETENTION - 1 }) as { place: number; ord: number } | undefined;

    if (kept !== undefined) {
      for (const [table, place] of [['messages', MESSAGE_PLACE], ['replies', REPLY_PLACE]] as const) {
        this.#db.prepare(`DELETE FROM ${table} WHERE sessionId = :id AND (${place} < :place OR (${place} = :place AND ord < :ord))`).run({ id: sessionId, place: kept.place, ord: kept.ord });
      }
    }
  }

  ticketHistory(ticketId: number): TicketHistory | null {
    const ticket = this.ticket(ticketId);

    if (ticket === null) {
      return null;
    }

    const triages = this.#all<Triage>('SELECT * FROM triages WHERE ticketId = ? ORDER BY startedAt, id', ticketId).map(({ context: _context, ...triage }) => triage);
    const workItems = this.#all<WorkItem>('SELECT * FROM workItems WHERE ticketId = ? ORDER BY id DESC', ticketId).map(({ taskPrompt, approvalPrompt: _approval, reportedPrompt: _reported, ...item }) => ({
      ...item,
      prompted: taskPrompt !== null,
      prompt: ownPrompt({ playbook: item.playbook, taskPrompt }),
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
