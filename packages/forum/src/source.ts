import { execFile } from 'node:child_process';
import { clip, githubLinks } from '@switchboard/core';
import type { ContextResult, PolledTicket, PollResult, Source, Ticket } from '@switchboard/core';

export interface ForumConfig {
  /** Runs SQL read from stdin against the forum database, such as the operator's `run-forum-sql.sh`. Switchboard never reads its connection. */
  queryCommand: string;
  forumId: number;
  /** The operator's forum `Person.Id`. */
  userId: string;
  /** A poll returning this many open topics is treated as incomplete. */
  maxRows: number;
  /** The change-history database on the same host, which records when a topic's status changed. */
  auditDatabase: string;
}

export type ConfigResult = { config: ForumConfig } | { error: string };

const KEYS = ['queryCommand', 'forumId', 'userId', 'maxRows', 'auditDatabase'];

/** Reads the Forum keys of the source `name`. */
export function parseForumConfig(options: Record<string, unknown>, name = 'forum'): ConfigResult {
  const path = `sources.${name}`;
  const unknown = Object.keys(options).filter((key) => !KEYS.includes(key));

  if (unknown.length > 0) {
    return { error: `${path}.${unknown[0]} is not a setting.` };
  }

  const { queryCommand = 'bash ~/.claude/scripts/run-forum-sql.sh', forumId = 1, userId, maxRows = 500, auditDatabase = 'audit' } = options;

  if (typeof queryCommand !== 'string' || queryCommand === '') {
    return { error: `${path}.queryCommand must be a non-empty string.` };
  }

  if (typeof userId !== 'string' || !/^\d+$/.test(userId)) {
    return { error: `${path}.userId must be set to your forum user ID, as a string.` };
  }

  if (typeof auditDatabase !== 'string' || !/^\w+$/.test(auditDatabase)) {
    return { error: `${path}.auditDatabase must be a database name.` };
  }

  for (const [key, value] of Object.entries({ forumId, maxRows })) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      return { error: `${path}.${key} must be a whole number of at least 1.` };
    }
  }

  return { config: { queryCommand, forumId: forumId as number, userId, maxRows: maxRows as number, auditDatabase } };
}

export type QueryResult = { rows: Record<string, unknown>[] } | { error: string };

/** Runs one read-only SQL statement and returns its rows. */
export type Query = (sql: string) => Promise<QueryResult>;

const QUERY_TIMEOUT_MS = 40_000;
/** The runner's exit code when the database cannot be reached, usually because the VPN is down. */
const OFFLINE = 7;

/**
 * Parses `--result-format=json/raw` output: one JSON object per line. A line that looks like a row but does not parse
 * makes the read incomplete, so a garbled row never reads as a topic that left.
 */
export function parseRows(stdout: string): QueryResult {
  const rows: Record<string, unknown>[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('{')) {
      continue;
    }

    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      return { error: 'The forum database returned a row that is not JSON.' };
    }
  }

  return { rows };
}

/** Pipes SQL to the query command through bash, so `~` and the runner script work as written. */
export function commandQuery(command: string, bash = 'bash'): Query {
  return (sql) =>
    new Promise((resolve) => {
      let inputError: Error | null = null;
      const child = execFile(bash, ['-c', `${command} --result-format=json/raw -`], { timeout: QUERY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error !== null) {
          resolve({
            error: error.code === OFFLINE ? 'The forum database cannot be reached; check the VPN.' : `The Forum query failed: ${stderr.trim().split(/\r?\n/).at(-1) || error.message}`,
          });
          return;
        }

        resolve(inputError === null ? parseRows(stdout) : { error: `The Forum query input failed: ${inputError.message}` });
      });

      child.stdin?.on('error', (error: Error) => { inputError = error; });
      child.stdin?.end(sql);
    });
}

/** MySQL `DATETIME` values are UTC without a zone. */
function utc(value: unknown): number | null {
  const time = typeof value === 'string' ? Date.parse(`${value.replace(' ', 'T')}Z`) : NaN;

  return Number.isNaN(time) ? null : time;
}

/** Each post is clipped to this many characters, as other sources' texts are. */
export const TEXT_LIMIT = 2_000;

/** Posts by this user are the automatic AI analysis, which triage leaves out (architecture.md § Settings). */
const AI_ANALYSIS_USER = 2;
/** `Entry.Status` of a private note. */
const PRIVATE = 2;
/** `EntityType.Thread` in the audit store. */
const TOPIC_ENTITY = 1;

function stripHtml(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class ForumSource implements Source {
  readonly queue = true;
  constructor(
    private readonly config: ForumConfig,
    private readonly query: Query,
    readonly name = 'forum',
  ) {}

  /** Open topics in the forum: yours are assigned, unassigned ones are the pool, and anyone else's are left out (PRD R5, R47). */
  async poll(): Promise<PollResult> {
    const result = await this.query(
      'SELECT t.Id, t.Title, t.`Key`, t.AssigneeId, t.CreatedUtc, lp.CreatedUtc AS LastPublicPostUtc FROM Thread t ' +
        'LEFT JOIN Entry lp ON lp.Id = t.LastPublicEntryId ' +
        `WHERE t.CommunityId = ${this.config.forumId} AND t.DeletedUtc IS NULL AND t.IsLocked = 0 AND t.Status = 0 ` +
        // Anyone else's topics are left out before the limit, so they never make a poll incomplete.
        `AND (t.AssigneeId IS NULL OR t.AssigneeId = ${this.config.userId}) LIMIT ${this.config.maxRows};`,
    );

    if ('error' in result) {
      return result;
    }

    if (result.rows.length >= this.config.maxRows) {
      return { error: `${this.config.maxRows} or more open Forum topics assigned to you or no one; raise sources.${this.name}.maxRows.` };
    }

    const tickets: PolledTicket[] = [];
    const kept = result.rows.filter((row) => row['AssigneeId'] === null || row['AssigneeId'] === undefined || String(row['AssigneeId']) === this.config.userId);
    const opened = await this.openedAt(kept.map((row) => Number(row['Id'])));

    if ('error' in opened) {
      return opened;
    }

    for (const row of kept) {
      const assignee = row['AssigneeId'] === null || row['AssigneeId'] === undefined ? null : String(row['AssigneeId']);

      tickets.push({
        sourceKey: String(row['Id']),
        ref: `T${String(row['Id'])}`,
        sourceId: null,
        title: String(row['Title'] ?? ''),
        url: `https://forum.example.com/t/forum/${String(row['Key'] ?? '')}`,
        assigned: assignee === this.config.userId,
        pool: assignee === null,
        // The last public post is how long the asker has waited; a topic without one falls back to its creation.
        sortAt: utc(row['LastPublicPostUtc']) ?? utc(row['CreatedUtc']),
        repo: '',
        enteredAt: opened.at.get(String(row['Id'])) ?? utc(row['CreatedUtc']),
      });
    }

    return { tickets };
  }

  /**
   * When each open topic last became Open (PRD R53): its latest audited Status change, since it is Open now. The insert lists every field, so
   * a topic whose status never changed counts from its creation (mechanics M15).
   */
  private async openedAt(ids: number[]): Promise<{ at: Map<string, number> } | { error: string }> {
    const at = new Map<string, number>();
    const valid = ids.filter((id) => Number.isInteger(id) && id > 0);

    if (valid.length === 0) {
      return { at };
    }

    const result = await this.query(
      `SELECT e.EntityId, MAX(s.CreatedUtc) AS OpenedUtc FROM ${this.config.auditDatabase}.AuditEntity e ` +
        `JOIN ${this.config.auditDatabase}.AuditScope s ON s.Id = e.ScopeId ` +
        `WHERE e.EntityType = ${TOPIC_ENTITY} AND e.EntityId IN (${valid.join(',')}) AND CONCAT(',', e.FieldNames, ',') LIKE '%,Status,%' ` +
        'GROUP BY e.EntityId;',
    );

    if ('error' in result) {
      return result;
    }

    for (const row of result.rows) {
      const time = utc(row['OpenedUtc']);

      if (time !== null) {
        at.set(String(row['EntityId']), time);
      }
    }

    return { at };
  }

  /** The topic's title and its public posts in order, without deleted posts, private notes or the AI analysis. */
  async context(ticket: Ticket): Promise<ContextResult> {
    const id = Number(ticket.sourceKey);

    if (!Number.isInteger(id) || id <= 0) {
      return { error: `Forum topic ${ticket.sourceKey} is not a topic ID.` };
    }

    const result = await this.query(
      "SELECT p.CreatedUtc, CONCAT_WS(' ', u.FirstName, u.LastName) AS Author, p.HtmlBody FROM Entry p LEFT JOIN Person u ON u.Id = p.UserId " +
        `WHERE p.ThreadId = ${id} AND p.DeletedUtc IS NULL AND (p.Status IS NULL OR p.Status <> ${PRIVATE}) AND p.UserId <> ${AI_ANALYSIS_USER} ` +
        'ORDER BY p.CreatedUtc;',
    );

    if ('error' in result) {
      return result;
    }

    const lines = [`Forum topic T${ticket.sourceKey}: ${ticket.title}`, ticket.url, '', '## Posts, oldest first'];
    // Links come from the unclipped HTML, so a clip cannot shorten a URL and a link's href counts.
    const bodies = [ticket.title];

    for (const row of result.rows) {
      const when = String(row['CreatedUtc'] ?? '').slice(0, 16);
      const author = String(row['Author'] ?? '').trim() || 'someone';
      const body = String(row['HtmlBody'] ?? '');

      lines.push('', `### ${author}, ${when}`, clip(stripHtml(body), TEXT_LIMIT));
      bodies.push(body);
    }

    return { context: lines.join('\n'), links: githubLinks(bodies) };
  }

  /** Forum worktrees are not named by topic, so none is linked by branch name. */
  keyOfBranch(): string | null {
    return null;
  }
}
