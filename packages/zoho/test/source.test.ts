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
    const override = overrides[path];

    if (override !== undefined) {
      return override;
    }

    if (path === `/tickets/${id}/conversations?limit=100`) {
      return { json: fixture('conversations') };
    }

    if (path === `/tickets/${id}/history?limit=100` || path === `/tickets/${id}/history?from=1&limit=100`) {
      return { json: fixture('history') };
    }

    // Other tickets' histories default to none, so their scope entry falls back to creation.
    if (/^\/tickets\/\d+\/history\?from=\d+&limit=100$/.test(path) && answers[path] === undefined) {
      return { json: [] };
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

    expect(get.mock.calls.map(([path]) => path)).toEqual(['/teams', '/tickets/search?status=Open&limit=100&from=1', ...support.slice(0, 3).map((row) => `/tickets/${row.id}/history?from=1&limit=100`)]);
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
        // The recorded ticket's history returns it to Open at 00:53; the others have none, so they count from creation.
        enteredAt: row.id === (fixture('ticket') as { id: string }).id ? Date.parse('2026-10-03T00:53:39.000Z') : Date.parse(row.createdTime),
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
      tickets: [{ sourceKey: '9', ref: '#9', sourceId: '1', title: 's', url: 'u', assigned: true, pool: false, sortAt: null, enteredAt: null }],
    });
  });

  it('enters scope at the later of the last escalation to Support and the last change to Open, reading the history again only when the ticket changes', async () => {
    const id = (fixture('ticket') as { id: string }).id;
    const row = (modifiedTime?: string) => ({
      id,
      ticketNumber: '7',
      subject: 's',
      webUrl: 'u',
      status: 'Open',
      createdTime: '2026-09-01T00:00:00Z',
      ...(modifiedTime === undefined ? {} : { modifiedTime }),
      assigneeId: null,
      cf: { cf_queue: 'Support' },
    });
    const page = (modifiedTime?: string) => ({ '/tickets/search?status=Open&limit=100&from=1': { json: { data: [row(modifiedTime)] } } });
    const entered = async (source: ZohoSource) => ((await source.poll()) as { tickets: { enteredAt: number | null }[] }).tickets[0]?.enteredAt;

    // The fixture: escalated to Support at 18:52, then Open → Deferred → Open, which is out of scope and back.
    const get = desk(page('2026-10-03T01:00:00Z'));
    const source = new ZohoSource(CONFIG, get);
    expect(await entered(source)).toBe(Date.parse('2026-10-03T00:53:39.000Z'));
    expect(await entered(source)).toBe(Date.parse('2026-10-03T00:53:39.000Z'));
    expect(get.mock.calls.filter(([path]) => path.includes('/history?'))).toHaveLength(1);

    // A re-escalation after a de-escalation counts; an escalation to another tier and another field do not.
    const history = [
      { eventTime: '2026-10-04T12:00:00Z', changes: [{ field: 'Team', newValue: 'Support' }] },
      { eventTime: '2026-10-04T00:00:00Z', changes: [{ field: 'Escalation', oldValue: 'General', newValue: 'Support' }] },
      { eventTime: '2026-10-03T00:00:00Z', changes: [{ field: 'Escalation', oldValue: 'Support', newValue: 'General' }] },
      { eventTime: '2026-10-02T00:00:00Z', changes: [{ field: 'Status', oldValue: 'On Hold', newValue: 'Open' }] },
    ];
    const changed = desk({ ...page(), [`/tickets/${id}/history?from=1&limit=100`]: { json: history } });
    const again = new ZohoSource(CONFIG, changed);
    expect(await entered(again)).toBe(Date.parse('2026-10-04T00:00:00Z'));
    // Without a modifiedTime the history is read on every poll.
    await again.poll();
    expect(changed.mock.calls.filter(([path]) => path.includes('/history?'))).toHaveLength(2);

    // No scope change in the history: the ticket's creation.
    expect(await entered(new ZohoSource(CONFIG, desk({ ...page(), [`/tickets/${id}/history?from=1&limit=100`]: { json: [history[0]] } })))).toBe(Date.parse('2026-09-01T00:00:00Z'));
    expect(await new ZohoSource(CONFIG, desk({ ...page(), [`/tickets/${id}/history?from=1&limit=100`]: { error: 'Zoho Desk rate-limited the read.' } })).poll()).toEqual({
      error: 'Zoho Desk rate-limited the read.',
    });
  });

  it('reads older history pages until a scope change, falling back to creation when the history ends without one and to null past ten pages', async () => {
    const id = (fixture('ticket') as { id: string }).id;
    const data = [{ id, ticketNumber: '7', subject: 's', webUrl: 'u', status: 'Open', createdTime: '2026-09-01T00:00:00Z', assigneeId: null, cf: { cf_queue: 'Support' } }];
    const noise = (n: number) => Array.from({ length: n }, () => ({ eventTime: '2026-10-04T00:00:00Z', changes: [{ field: 'Priority', newValue: 'High' }] }));
    const escalated = { eventTime: '2026-09-10T00:00:00Z', changes: [{ field: 'Escalation', oldValue: 'General', newValue: 'Support' }] };
    const pages = (second: unknown[]) =>
      desk({
        '/tickets/search?status=Open&limit=100&from=1': { json: { data } },
        [`/tickets/${id}/history?from=1&limit=100`]: { json: noise(100) },
        [`/tickets/${id}/history?from=101&limit=100`]: { json: second },
      });
    const entered = async (get: ReturnType<typeof desk>) => ((await new ZohoSource(CONFIG, get).poll()) as { tickets: { enteredAt: number | null }[] }).tickets[0]?.enteredAt;

    expect(await entered(pages([...noise(3), escalated]))).toBe(Date.parse('2026-09-10T00:00:00Z'));
    expect(await entered(pages(noise(3)))).toBe(Date.parse('2026-09-01T00:00:00Z'));

    // Ten full pages without a scope change: unknown rather than the creation, so Switchboard keeps the time it has.
    const long = vi.fn<DeskGet>(async (path) =>
      path === '/teams' ? { json: fixture('teams') } : path.startsWith('/tickets/search') ? { json: { data } } : { json: noise(100) },
    );
    expect(await entered(long)).toBeNull();
    expect(long.mock.calls.filter(([path]) => path.includes('/history?'))).toHaveLength(10);
  });

  it('reads the history again when modifiedTime changes, and forgets tickets that left', async () => {
    const id = (fixture('ticket') as { id: string }).id;
    let rows: object[] = [];
    const get = vi.fn<DeskGet>(async (path) => {
      if (path === '/teams') {
        return { json: fixture('teams') };
      }

      return path.startsWith('/tickets/search') ? { json: { data: rows } } : { json: [] };
    });
    const row = (modifiedTime: string) => ({ id, ticketNumber: '7', subject: 's', webUrl: 'u', status: 'Open', createdTime: '2026-09-01T00:00:00Z', modifiedTime, assigneeId: null, cf: { cf_queue: 'Support' } });
    const source = new ZohoSource(CONFIG, get);
    const reads = () => get.mock.calls.filter(([path]) => path.includes('/history?')).length;

    rows = [row('a')];
    await source.poll();
    await source.poll();
    expect(reads()).toBe(1);
    rows = [row('b')];
    await source.poll();
    expect(reads()).toBe(2);
    rows = [];
    await source.poll();
    rows = [row('b')];
    await source.poll();
    expect(reads()).toBe(3);
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
  const ticket = (sourceId: string | null): Ticket => ({ id: 1, source: 'zoho', sourceKey: '900007', ref: '#900007', sourceId, title: 'Ticket 900007', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '', adhocKey: null });

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
    expect(result).toMatchObject({ links: [] });
  });

  it('links each distinct GitHub issue and pull request in the conversation, including one clipped out of the context (PRD R61)', async () => {
    const detail = fixture('ticket') as { id: string };
    const threads = fixture('links-threads') as { id: string }[];
    const get = desk({
      [`/tickets/${detail.id}/conversations?limit=100`]: { json: fixture('links-conversations') },
      ...Object.fromEntries(threads.map((thread) => [`/tickets/${detail.id}/threads/${thread.id}`, { json: thread }])),
    });
    const result = (await new ZohoSource(CONFIG, get).context(ticket(detail.id))) as { context: string; links: unknown };

    // The issue appears three times: as an href, as link text, and with a comment anchor. The help page, a file and a project are not links.
    expect(result.links).toEqual([
      { label: 'Issue #19515', target: 'https://github.com/acme/widgets/issues/19515' },
      { label: 'Pull request #19600', target: 'https://github.com/acme/widgets/pull/19600' },
      { label: 'Pull request #19601', target: 'https://github.com/acme/widgets/pull/19601' },
    ]);
    expect(result.context).not.toContain('19601');
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
