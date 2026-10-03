import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ticket } from '@switchboard/core';
import { describe, expect, it, vi } from 'vitest';
import { ForumSource, commandQuery, parseForumConfig, parseRows } from '../src/source.js';
import type { ForumConfig, Query } from '../src/source.js';

const raw = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', `${name}.jsonl`), 'utf8');
const CONFIG = (parseForumConfig({ userId: '7' }) as { config: ForumConfig }).config;

describe('ForumSource.poll', () => {
  it('reads open topics in the forum: unassigned ones are the pool, yours are assigned, and anyone else’s are left out', async () => {
    const query = vi.fn<Query>(async () => parseRows(raw('topics')));
    const result = await new ForumSource(CONFIG, query).poll();

    expect(query.mock.calls[0]?.[0]).toBe(
      'SELECT t.Id, t.Title, t.`Key`, t.AssigneeId, t.CreatedUtc, lp.CreatedUtc AS LastPublicPostUtc FROM Thread t LEFT JOIN Entry lp ON lp.Id = t.LastPublicEntryId WHERE t.CommunityId = 1 AND t.DeletedUtc IS NULL AND t.IsLocked = 0 AND t.Status = 0 LIMIT 500;',
    );

    const tickets = (result as { tickets: { sourceKey: string; assigned: boolean; pool: boolean; sortAt: number | null; url: string; title: string }[] }).tickets;

    // Recorded live: 7 open topics, none assigned; two synthetic rows add yours and someone else's.
    expect(tickets).toHaveLength(8);
    expect(tickets.filter((ticket) => ticket.pool)).toHaveLength(7);
    expect(tickets.find((ticket) => ticket.sourceKey === '90100')).toEqual({
      sourceKey: '90100',
      sourceId: null,
      title: 'Topic 90100',
      url: 'https://forum.example.com/t/forum/topic-90100',
      assigned: true,
      pool: false,
      sortAt: Date.UTC(2026, 8, 2, 11, 0, 0),
    });
    expect(tickets.some((ticket) => ticket.sourceKey === '90101')).toBe(false);
    expect(tickets[0]).toMatchObject({ sourceKey: '90001', sortAt: Date.UTC(2026, 9, 1, 17, 54, 51) });
  });

  it('falls back to the creation time, and fails at the row limit or on a query error', async () => {
    const row = JSON.stringify({ Id: 5, Title: 't', Key: 'k', AssigneeId: null, CreatedUtc: '2026-01-02 03:04:05', LastPublicPostUtc: null });

    expect(await new ForumSource(CONFIG, async () => parseRows(row)).poll()).toEqual({
      tickets: [{ sourceKey: '5', sourceId: null, title: 't', url: 'https://forum.example.com/t/forum/k', assigned: false, pool: true, sortAt: Date.UTC(2026, 0, 2, 3, 4, 5) }],
    });
    expect(await new ForumSource({ ...CONFIG, maxRows: 1 }, async () => parseRows(row)).poll()).toEqual({ error: '1 or more open Forum topics; raise sources.forum.maxRows.' });
    expect(await new ForumSource(CONFIG, async () => ({ error: 'The forum database cannot be reached; check the VPN.' })).poll()).toEqual({ error: 'The forum database cannot be reached; check the VPN.' });
  });
});

describe('ForumSource.context', () => {
  const ticket: Ticket = { id: 1, source: 'forum', sourceKey: '90001', sourceId: null, title: 'Topic 90001', url: 'https://forum.example.com/t/forum/topic-90001', assigned: false, pool: true, iceboxed: false, sortAt: null, lastPolledAt: null, repoRoot: '' };

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
  });
});

describe('parseForumConfig', () => {
  it('applies defaults and validates', () => {
    expect(parseForumConfig({ userId: '7' })).toEqual({ config: { queryCommand: 'bash ~/.claude/scripts/run-forum-sql.sh', forumId: 1, userId: '7', maxRows: 500 } });
    expect(parseForumConfig({})).toEqual({ error: 'sources.forum.userId must be set to your forum user ID, as a string.' });
    expect(parseForumConfig({ userId: '1', databaseEnvPath: 'x' })).toEqual({ error: 'sources.forum.databaseEnvPath is not a setting.' });
    expect(parseForumConfig({ userId: '1', queryCommand: '' })).toEqual({ error: 'sources.forum.queryCommand must be a non-empty string.' });
    expect(parseForumConfig({ userId: '1', forumId: 0 })).toEqual({ error: 'sources.forum.forumId must be a whole number of at least 1.' });
  });
});
