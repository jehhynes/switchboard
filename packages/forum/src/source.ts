import { execFile } from 'node:child_process';
import { clip } from '@switchboard/core';
import type { ContextResult, PolledTicket, PollResult, Source, Ticket } from '@switchboard/core';

export interface ForumConfig {
  /** Runs SQL read from stdin against the forum database, such as the operator's `run-forum-sql.sh`. Switchboard never reads its connection. */
  queryCommand: string;
  forumId: number;
  /** The operator's forum `Person.Id`. */
  userId: string;
  /** A poll returning this many open topics is treated as incomplete. */
  maxRows: number;
}

export type ConfigResult = { config: ForumConfig } | { error: string };

const KEYS = ['queryCommand', 'forumId', 'userId', 'maxRows'];

/** Reads the Forum keys of `sources.forum`. */
export function parseForumConfig(options: Record<string, unknown>): ConfigResult {
  const unknown = Object.keys(options).filter((key) => !KEYS.includes(key));

  if (unknown.length > 0) {
    return { error: `sources.forum.${unknown[0]} is not a setting.` };
  }

  const { queryCommand = 'bash ~/.claude/scripts/run-forum-sql.sh', forumId = 1, userId, maxRows = 500 } = options;

  if (typeof queryCommand !== 'string' || queryCommand === '') {
    return { error: 'sources.forum.queryCommand must be a non-empty string.' };
  }

  if (typeof userId !== 'string' || !/^\d+$/.test(userId)) {
    return { error: 'sources.forum.userId must be set to your forum user ID, as a string.' };
  }

  for (const [key, value] of Object.entries({ forumId, maxRows })) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      return { error: `sources.forum.${key} must be a whole number of at least 1.` };
    }
  }

  return { config: { queryCommand, forumId: forumId as number, userId, maxRows: maxRows as number } };
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
      const child = execFile(bash, ['-c', `${command} --result-format=json/raw -`], { timeout: QUERY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error !== null) {
          resolve({
            error: error.code === OFFLINE ? 'The forum database cannot be reached; check the VPN.' : `The Forum query failed: ${stderr.trim().split(/\r?\n/).at(-1) || error.message}`,
          });
          return;
        }

        resolve(parseRows(stdout));
      });

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
  readonly name = 'forum';

  constructor(
    private readonly config: ForumConfig,
    private readonly query: Query,
  ) {}

  /** Open topics in the forum: yours are assigned, unassigned ones are the pool, and anyone else's are left out (PRD R5, R47). */
  async poll(): Promise<PollResult> {
    const result = await this.query(
      'SELECT t.Id, t.Title, t.`Key`, t.AssigneeId, t.CreatedUtc, lp.CreatedUtc AS LastPublicPostUtc FROM Thread t ' +
        'LEFT JOIN Entry lp ON lp.Id = t.LastPublicEntryId ' +
        `WHERE t.CommunityId = ${this.config.forumId} AND t.DeletedUtc IS NULL AND t.IsLocked = 0 AND t.Status = 0 ` +
        `LIMIT ${this.config.maxRows};`,
    );

    if ('error' in result) {
      return result;
    }

    if (result.rows.length >= this.config.maxRows) {
      return { error: `${this.config.maxRows} or more open Forum topics; raise sources.forum.maxRows.` };
    }

    const tickets: PolledTicket[] = [];

    for (const row of result.rows) {
      const assignee = row['AssigneeId'] === null || row['AssigneeId'] === undefined ? null : String(row['AssigneeId']);

      if (assignee !== null && assignee !== this.config.userId) {
        continue;
      }

      tickets.push({
        sourceKey: String(row['Id']),
        sourceId: null,
        title: String(row['Title'] ?? ''),
        url: `https://forum.example.com/t/forum/${String(row['Key'] ?? '')}`,
        assigned: assignee !== null,
        pool: assignee === null,
        // The last public post is how long the asker has waited; a topic without one falls back to its creation.
        sortAt: utc(row['LastPublicPostUtc']) ?? utc(row['CreatedUtc']),
      });
    }

    return { tickets };
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

    for (const row of result.rows) {
      const when = String(row['CreatedUtc'] ?? '').slice(0, 16);
      const author = String(row['Author'] ?? '').trim() || 'someone';

      lines.push('', `### ${author}, ${when}`, clip(stripHtml(String(row['HtmlBody'] ?? '')), TEXT_LIMIT));
    }

    return { context: lines.join('\n') };
  }

  /** Forum worktrees are not named by topic, so none is linked by branch name. */
  keyOfBranch(): string | null {
    return null;
  }
}
