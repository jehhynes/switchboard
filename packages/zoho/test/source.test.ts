import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ticket } from '@switchboard/core';
import { describe, expect, it, vi } from 'vitest';
import { parseZohoConfig } from '../src/config.js';
import type { ZohoConfig } from '../src/config.js';
import type { DeskGet, DeskResult } from '../src/desk.js';
import { TEAMS_TTL_MS, ZohoSource } from '../src/source.js';
import { stripHtml } from '../src/text.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8'));

const SELF = '8000000000000000001';
const CONFIG = (parseZohoConfig({ orgId: '700000001', agentId: SELF }) as { config: ZohoConfig }).config;

/** Answers Desk paths from fixtures; fails on an unexpected path. */
function desk(overrides: Record<string, DeskResult> = {}) {
  const threads = fixture('threads') as { id: string }[];
  const answers: Record<string, DeskResult> = {
    '/teams': { json: fixture('teams') },
    '/tickets/search?status=Open&limit=100&from=1': { json: fixture('search') },
    [`/tickets/${(fixture('ticket') as { id: string }).id}`]: { json: fixture('ticket') },
    ...overrides,
  };

  return vi.fn<DeskGet>(async (path) => {
    const id = (fixture('ticket') as { id: string }).id;

    if (path === `/tickets/${id}/conversations?limit=100`) {
      return { json: fixture('conversations') };
    }

    if (path === `/tickets/${id}/history?limit=100`) {
      return { json: fixture('history') };
    }

    const thread = /\/threads\/(\d+)$/.exec(path)?.[1];

    if (thread !== undefined) {
      return { json: threads.find((entry) => entry.id === thread) ?? null };
    }

    const answer = answers[path];

    if (answer === undefined) {
      throw new Error(`unexpected path ${path}`);
    }

    return answer;
  });
}

const search = fixture('search') as { data: { ticketNumber: string; id: string; createdTime: string; customerResponseTime: string | null; assigneeId: string | null; cf: { cf_queue: string | null } }[] };
const support = search.data.filter((row) => row.cf.cf_queue === 'Support');

describe('ZohoSource.poll', () => {
  it('lists Support tickets by ticket number with the internal ID: none of them yours, the unclaimed ones in the pool, and another engineer’s left out', async () => {
    const get = desk();
    const result = await new ZohoSource(CONFIG, get).poll();

    expect(get.mock.calls.map(([path]) => path)).toEqual(['/teams', '/tickets/search?status=Open&limit=100&from=1']);
    expect(search.data).toHaveLength(17);
    // Recorded live: three Support tickets held by support agents, so in the pool, and two by an engineer, so left out.
    expect(result).toEqual({
      tickets: support.slice(0, 3).map((row) => ({
        sourceKey: row.ticketNumber,
        ref: `#${row.ticketNumber}`,
        sourceId: row.id,
        title: `Ticket ${row.ticketNumber}`,
        url: `https://desk.example.test/tickets/${row.ticketNumber}`,
        assigned: false,
        pool: true,
        sortAt: Date.parse(row.customerResponseTime ?? row.createdTime),
      })),
    });
    expect(support).toHaveLength(5);
  });

  it('pages until a short page and fails past maxPages', async () => {
    const full = { json: { data: Array.from({ length: 100 }, (_, n) => ({ id: String(n), ticketNumber: String(n), subject: 's', webUrl: 'u', assigneeId: null, cf: {} })) } };
    const get = desk({ '/tickets/search?status=Open&limit=100&from=1': full, '/tickets/search?status=Open&limit=100&from=101': { empty: true } });

    expect(await new ZohoSource(CONFIG, get).poll()).toEqual({ tickets: [] });
    expect(get).toHaveBeenCalledTimes(3);

    expect(await new ZohoSource({ ...CONFIG, maxPages: 1 }, desk({ '/tickets/search?status=Open&limit=100&from=1': full })).poll()).toEqual({
      error: 'More than 1 pages of Open tickets; raise sources.zoho.maxPages.',
    });
  });

  it('fails the poll when the teams cannot be read, and on any Desk error', async () => {
    expect(await new ZohoSource(CONFIG, desk({ '/teams': { json: { teams: [] } } })).poll()).toEqual({
      error: 'Zoho Desk returned no teams, so support assignees cannot be told from engineers.',
    });
    expect(await new ZohoSource(CONFIG, desk({ '/teams': { error: 'Zoho Desk rate-limited the read.' } })).poll()).toEqual({ error: 'Zoho Desk rate-limited the read.' });
    expect(await new ZohoSource(CONFIG, desk({ '/tickets/search?status=Open&limit=100&from=1': { json: { data: 'x' } } })).poll()).toEqual({ error: 'Zoho Desk returned an unexpected response.' });
  });

  it('marks your own ticket assigned and not in the pool', async () => {
    const mine = { json: { data: [{ id: '1', ticketNumber: '9', subject: 's', webUrl: 'u', assigneeId: SELF, cf: { cf_queue: 'Support' } }] } };

    expect(await new ZohoSource(CONFIG, desk({ '/tickets/search?status=Open&limit=100&from=1': mine })).poll()).toEqual({
      tickets: [{ sourceKey: '9', ref: '#9', sourceId: '1', title: 's', url: 'u', assigned: true, pool: false, sortAt: null }],
    });
  });

  it('reads the teams once per six hours', async () => {
    let now = 0;
    const get = desk();
    const source = new ZohoSource(CONFIG, get, () => now);

    await source.poll();
    now = TEAMS_TTL_MS - 1;
    await source.poll();
    now = TEAMS_TTL_MS;
    await source.poll();

    expect(get.mock.calls.filter(([path]) => path === '/teams')).toHaveLength(2);
  });
});

describe('ZohoSource.classify', () => {
  it('tells mine, none, support and engineer apart (Support board classifyAssignee)', () => {
    const source = new ZohoSource(CONFIG, desk());
    const teamOf = new Map([['111', ['Helpdesk']]]);

    expect([SELF, null, '', '8000000000000000002', '111', '222'].map((id) => source.classify(id, teamOf))).toEqual(['mine', 'none', 'none', 'support', 'support', 'engineer']);
  });
});

describe('ZohoSource.context', () => {
  const ticket = (sourceId: string | null): Ticket => ({ id: 1, source: 'zoho', sourceKey: '900007', ref: '#900007', sourceId, title: 'Ticket 900007', url: '', assigned: true, pool: false, iceboxed: false, sortAt: null, lastPolledAt: null, repoRoot: '' });

  it('formats the subject, fields, tier and owner history, and the conversation oldest first, clipping each text', async () => {
    const detail = fixture('ticket') as { id: string; ticketNumber: string; status: string };
    const result = await new ZohoSource(CONFIG, desk()).context(ticket(detail.id));
    const text = (result as { context: string }).context;
    const lines = text.split('\n');

    expect(lines.slice(0, 3)).toEqual([`Zoho Desk ticket #900007: Ticket ${detail.ticketNumber}`, `Status: ${detail.status}`, expect.stringMatching(/^Assignee: (support|engineer) agent \d{19}$/)]);
    expect(lines[3]).toBe('cf_queue: Support');
    expect(text).toContain('## Tier, owner and status history\n2026-10-02 16:43');
    expect(text).toContain('Escalation General → Support');
    expect(text).toMatch(/Team \(none\) → (Helpdesk|General|Engagement|Marketing|Onboarding)/);
    expect(text.match(/^### /gm)).toHaveLength(20);
    expect(text.indexOf('## Conversation, oldest first\n\n### Message from the customer by Customer 1, 2026-10-02 16:42')).toBeGreaterThan(0);
    expect(text).toContain('### Internal note by Agent');
    expect(text).not.toMatch(/<div>|<br>/);
    expect(text.match(/\[…\d+ characters omitted…\]/g)?.length).toBeGreaterThan(0);
  });

  it('reads a sparse ticket: no detail, an unassigned owner, missing names and an unreadable thread', async () => {
    const get = vi.fn<DeskGet>(async (path) => {
      if (path === '/teams') return { json: fixture('teams') };
      if (path === '/tickets/77') return { empty: true };
      if (path === '/tickets/77/conversations?limit=100') {
        return { json: { data: [{ id: '5', type: 'thread', direction: 'out', summary: 'Short' }, { id: '6', type: 'comment', isPublic: true, commenter: { firstName: 'Ann', lastName: 'B' }, content: 'Hi' }] } };
      }
      if (path === '/tickets/77/history?limit=100') {
        return { json: [{ eventTime: '2026-10-01T10:00:00.000Z', changes: [{ field: 'Case Owner', oldValue: null, newValue: SELF }, { field: 'Priority', oldValue: 'Low', newValue: 'High' }] }] };
      }
      if (path === '/tickets/77/threads/5') return { empty: true };
      throw new Error(path);
    });
    const text = ((await new ZohoSource(CONFIG, get).context({ ...ticket('77'), title: 'Fallback title' })) as { context: string }).context;

    expect(text.split('\n').slice(0, 3)).toEqual(['Zoho Desk ticket #900007: Fallback title', 'Status: unknown', 'Assignee: nobody']);
    expect(text).toContain('2026-10-01 10:00 Zoho: Case Owner (none) → you');
    expect(text).not.toContain('Priority');
    expect(text).toContain('### Public comment by Ann B, \nHi');
    expect(text).toContain('### Message to the customer by someone, \nShort');
  });

  it('fails without an internal ID or on a Desk error', async () => {
    const detail = fixture('ticket') as { id: string };

    expect(await new ZohoSource(CONFIG, desk()).context(ticket(null))).toEqual({ error: 'Zoho ticket 900007 has no internal ID.' });
    expect(await new ZohoSource(CONFIG, desk({ [`/tickets/${detail.id}`]: { error: 'Zoho Desk answered HTTP 404 for /tickets/1.' } })).context(ticket(detail.id))).toEqual({
      error: 'Zoho Desk answered HTTP 404 for /tickets/1.',
    });
  });

  it('links no worktree by branch name', () => {
    expect(new ZohoSource(CONFIG, desk()).keyOfBranch()).toBeNull();
  });
});

describe('stripHtml', () => {
  it('keeps text and line breaks', () => {
    expect(stripHtml('<div>Hi&nbsp;there</div><br><p>a &amp; b &lt;c&gt; &#39;d&#39; &#x41;</p>\n\n\n\nend')).toBe("Hi there\n\na & b <c> 'd' A\n\nend");
  });
});
