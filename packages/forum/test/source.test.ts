import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ticket } from '@switchboard/core';
import { describe, expect, it, vi } from 'vitest';
import { ForumSource, commandQuery, parseForumConfig, parseRows } from '../src/source.js';
import type { ForumConfig, Query, QueryResult } from '../src/source.js';

const raw = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', `${name}.jsonl`), 'utf8');
const CONFIG = (parseForumConfig({ userId: '7' }) as { config: ForumConfig }).config;

describe('ForumSource.poll', () => {
  it('retains all open topics without audit reads for other assignees', async () => {
    const opened = JSON.stringify({ EntityId: 90100, OpenedUtc: '2026-09-20 08:00:00.123' });
    const query = vi.fn<Query>(async (sql) => parseRows(sql.includes('AuditEntity') ? opened : raw('topics')));
    const result = await new ForumSource(CONFIG, query).poll();

    expect(query.mock.calls[0]?.[0]).toBe(
      'SELECT t.Id, t.Title, t.`Key`, t.AssigneeId, t.CreatedUtc, lp.CreatedUtc AS LastPublicPostUtc FROM Thread t LEFT JOIN Entry lp ON lp.Id = t.LastPublicEntryId WHERE t.CommunityId = 1 AND t.DeletedUtc IS NULL AND t.IsLocked = 0 AND t.Status = 0 LIMIT 500;',
    );

    // Someone else's topic is not looked up; a topic is Open since its latest audited Status change.
    expect(query.mock.calls[1]?.[0]).toBe(
      'SELECT e.EntityId, MAX(s.CreatedUtc) AS OpenedUtc FROM audit.AuditEntity e JOIN audit.AuditScope s ON s.Id = e.ScopeId ' +
        "WHERE e.EntityType = 1 AND e.EntityId IN (90001,90002,90003,90004,90005,90006,90007,90100) AND CONCAT(',', e.FieldNames, ',') LIKE '%,Status,%' GROUP BY e.EntityId;",
    );

    const tickets = (result as { tickets: { sourceKey: string; assigned: boolean; pool: boolean; sortAt: number | null; enteredAt: number | null }[] }).tickets;

    // Recorded live: 7 open topics, none assigned; two synthetic rows add yours and someone else's.
    expect(tickets).toHaveLength(9);
    expect(tickets.filter((ticket) => ticket.pool)).toHaveLength(7);
    expect(tickets.find((ticket) => ticket.sourceKey === '90100')).toEqual({
      sourceKey: '90100',
      ref: 'T90100',
      sourceId: null,
      title: 'Topic 90100',
      url: 'https://forum.example.com/t/forum/topic-90100',
      assigned: true,
      pool: false,
      inQueue: true,
      assigneeId: CONFIG.userId,
      sortAt: Date.UTC(2026, 8, 2, 11, 0, 0),
      enteredAt: Date.UTC(2026, 8, 20, 8, 0, 0, 123),
    });
    expect(tickets.find((ticket) => ticket.sourceKey === '90101')).toMatchObject({ assigned: false, pool: false, inQueue: true, enteredAt: null });
    expect(tickets[0]).toMatchObject({ sourceKey: '90001', sortAt: Date.UTC(2026, 9, 1, 17, 54, 51), enteredAt: Date.UTC(2026, 9, 1, 17, 54, 51) });
  });

  it('falls back to the creation time, and fails at the row limit or on a query error', async () => {
    const row = JSON.stringify({ Id: 5, Title: 't', Key: 'k', AssigneeId: null, CreatedUtc: '2026-01-02 03:04:05', LastPublicPostUtc: null });
    const topics = (audit: QueryResult) => async (sql: string) => (sql.includes('AuditEntity') ? audit : parseRows(row));

    expect(await new ForumSource(CONFIG, topics({ rows: [] })).poll()).toEqual({
      tickets: [{ sourceKey: '5', ref: 'T5', sourceId: null, title: 't', url: 'https://forum.example.com/t/forum/k', assigned: false, pool: true, inQueue: true, assigneeId: null, sortAt: Date.UTC(2026, 0, 2, 3, 4, 5), enteredAt: Date.UTC(2026, 0, 2, 3, 4, 5) }],
    });
    expect(await new ForumSource(CONFIG, topics({ error: 'Access denied to audit.' })).poll()).toEqual({ error: 'Access denied to audit.' });
    // With no topic, the audit store is not read.
    const empty = vi.fn<Query>(async () => ({ rows: [] }));
    expect(await new ForumSource(CONFIG, empty).poll()).toEqual({ tickets: [] });
    expect(empty).toHaveBeenCalledTimes(1);
    expect(await new ForumSource({ ...CONFIG, maxRows: 1 }, async () => parseRows(row)).poll()).toEqual({ error: '1 or more open Forum topics; raise sources.forum.maxRows.' });
    expect(await new ForumSource(CONFIG, async () => ({ error: 'The forum database cannot be reached; check the VPN.' })).poll()).toEqual({ error: 'The forum database cannot be reached; check the VPN.' });
  });
});

describe('ForumSource.context', () => {
  const ticket: Ticket = { id: 1, source: 'forum', sourceKey: '90001', ref: 'T90001', sourceId: null, title: 'Topic 90001', url: 'https://forum.example.com/t/forum/topic-90001', assigned: false, pool: true, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '', adhocKey: null, blockers: [] };

  it('lists the public posts oldest first, without deleted posts, private notes or the AI analysis', async () => {
    const query = vi.fn<Query>(async () => parseRows(raw('posts')));
    const text = ((await new ForumSource(CONFIG, query).context(ticket)) as { context: string }).context;

    expect(query.mock.calls[0]?.[0]).toBe(
      "SELECT p.CreatedUtc, CONCAT_WS(' ', u.FirstName, u.LastName) AS Author, p.HtmlBody FROM Entry p LEFT JOIN Person u ON u.Id = p.UserId WHERE p.ThreadId = 90001 AND p.DeletedUtc IS NULL AND (p.Status IS NULL OR p.Status <> 2) AND p.UserId <> 2 ORDER BY p.CreatedUtc;",
    );
    expect(text.split('\n').slice(0, 6)).toEqual([
      'Forum topic T90001: Topic 90001',
      'https://forum.example.com/t/forum/topic-90001',
      '',
      '## Posts, oldest first',
      '',
      '### Person 1, 2026-10-01 17:54',
    ]);
    expect(text).toMatch(/Post starts here\..*\nPost ends here\.$/s);
    expect(text).not.toContain('<p>');
    expect(await new ForumSource(CONFIG, query).context(ticket)).toMatchObject({ links: [] });
  });

  it('links each distinct GitHub issue and pull request in the posts, including one clipped out of the context (PRD R61)', async () => {
    const result = (await new ForumSource(CONFIG, async () => parseRows(raw('links-posts'))).context(ticket)) as { context: string; links: unknown };

    // The issue appears three times: as an href, as link text, and with a comment anchor. The help page and the topic's own URL are not links.
    expect(result.links).toEqual([
      { label: 'Issue #19515', target: 'https://github.com/acme/widgets/issues/19515', mentioned: true },
      { label: 'Pull request #19600', target: 'https://github.com/acme/widgets/pull/19600', mentioned: true },
    ]);
    expect(result.context).not.toContain('19600');
  });

  it('refuses a key that is not a topic ID and passes a query error through', async () => {
    expect(await new ForumSource(CONFIG, vi.fn<Query>()).context({ ...ticket, sourceKey: '1; DROP' })).toEqual({ error: 'Forum topic 1; DROP is not a topic ID.' });
    expect(await new ForumSource(CONFIG, async () => ({ error: 'boom' })).context(ticket)).toEqual({ error: 'boom' });
    expect(new ForumSource(CONFIG, vi.fn<Query>()).keyOfBranch()).toBeNull();
  });
});

describe('parseRows and commandQuery', () => {
  it('reads one JSON row per line, skips other output, and rejects a garbled row', () => {
    expect(parseRows('WARNING: password on the command line\n{"a":1}\r\n{"a":2}\n')).toEqual({ rows: [{ a: 1 }, { a: 2 }] });
    expect(parseRows('{"a":1}\n{"a":')).toEqual({ error: 'The forum database returned a row that is not JSON.' });
  });

  it('pipes SQL to the command and reports the offline exit code and other failures', async () => {
    // `cat` stands in for the runner: it ignores the flags and echoes stdin.
    expect(await commandQuery('cat #')('{"n":1}')).toEqual({ rows: [{ n: 1 }] });
    expect(await commandQuery('exit 7 #')('x')).toEqual({ error: 'The forum database cannot be reached; check the VPN.' });
    expect(await commandQuery('echo denied >&2; exit 2 #')('x')).toEqual({ error: 'The Forum query failed: denied' });
    expect(await commandQuery('cat #', 'no-such-bash')('x')).toEqual({ error: expect.stringMatching(/^The Forum query failed: .*ENOENT/) });
  });
});

describe('parseForumConfig', () => {
  it('applies defaults and validates', () => {
    expect(parseForumConfig({ userId: '7' })).toEqual({ config: { queryCommand: 'bash ~/.claude/scripts/run-forum-sql.sh', forumId: 1, userId: '7', maxRows: 500, auditDatabase: 'audit' } });
    expect(parseForumConfig({ userId: '1', auditDatabase: 'x; DROP' })).toEqual({ error: 'sources.forum.auditDatabase must be a database name.' });
    expect(parseForumConfig({})).toEqual({ error: 'sources.forum.userId must be set to your forum user ID, as a string.' });
    expect(parseForumConfig({ userId: '1', databaseEnvPath: 'x' })).toEqual({ error: 'sources.forum.databaseEnvPath is not a setting.' });
    expect(parseForumConfig({ userId: '1', queryCommand: '' })).toEqual({ error: 'sources.forum.queryCommand must be a non-empty string.' });
    expect(parseForumConfig({ userId: '1', forumId: 0 })).toEqual({ error: 'sources.forum.forumId must be a whole number of at least 1.' });
  });
});
