import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Anchor, Ticket, TicketBlocker } from '@switchboard/core';
import { describe, expect, it, vi } from 'vitest';
import { parseGithubConfig } from '../src/config.js';
import type { GithubConfig } from '../src/config.js';
import type { Gh, GhResult } from '../src/gh.js';
import { CONTEXT_QUERY, FIELD_QUERY, ISSUE_QUERY, ISSUES_QUERY, PULL_REQUEST_QUERY } from '../src/queries.js';
import { ASSIGNMENT_QUERY } from '../src/assignment.js';
import { GithubSource } from '../src/source.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8'));
}

const CONFIG = parseGithubConfig({
  repo: 'acme/widgets',
  logins: ['work-login', 'work-ai-login'],
  project: { owner: 'acme', number: 3, statusField: 'Status' },
  assignedStatuses: ['🎁 Assigned', '⚒️ Dev', '🔍 Review'],
});

const config = (patch: Partial<GithubConfig> = {}): GithubConfig => ({ ...(CONFIG as { config: GithubConfig }).config, ...patch });

/** A fake gh that answers each call in turn and fails on an unexpected call. */
function fakeGh(...answers: GhResult[]) {
  return vi.fn<Gh>(async () => {
    const answer = answers.shift();

    if (answer === undefined) {
      throw new Error('unexpected gh call');
    }

    return answer;
  });
}

const SINGLE_SELECT: GhResult = { json: { data: { repositoryOwner: { projectV2: { field: { __typename: 'ProjectV2SingleSelectField' } } } } } };

const ticket = (sourceKey: string): Ticket => ({ id: 1, source: 'github', sourceKey, ref: `#${sourceKey}`, repo: '', sourceId: null, title: '', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '', adhocKey: null, blockers: [] });

describe('GithubSource.poll', () => {
  it('lists every searched issue, assigned only when its project status is configured', async () => {
    const gh = fakeGh(SINGLE_SELECT, { json: fixture('issues') });
    const result = await new GithubSource(config(), gh).poll();

    expect(gh).toHaveBeenCalledWith(ISSUES_QUERY, { q: 'repo:acme/widgets is:issue is:open assignee:work-login assignee:work-ai-login project:acme/3', status: 'Status' });
    expect(result).toEqual({
      tickets: [20190, 20127, 19964, 19769, 19504, 19484, 19231, 19230, 18531, 18388, 18111].map((number) => ({
        sourceKey: String(number),
        ref: `#${number}`,
        repo: 'acme/widgets',
        sourceId: null,
        title: `Issue ${number}`,
        url: `https://github.com/acme/widgets/issues/${number}`,
        assigned: number !== 19231 && number !== 19230,
        pool: false,
        sortAt: null,
        enteredAt: null,
        blockers: [],
      })),
    });
  });

  it("sets the sort time to the later of the operator's latest assignment and the last Status change", async () => {
    const node = (number: number, statusAt: string | undefined, assignees: [string, string][]) => ({
      number,
      title: 'T',
      url: 'u',
      projectItems: { nodes: [{ project: { number: 3, owner: { login: 'acme' } }, fieldValueByName: { name: '⚒️ Dev', ...(statusAt === undefined ? {} : { updatedAt: statusAt }) } }] },
      timelineItems: { nodes: assignees.map(([login, createdAt]) => ({ createdAt, assignee: { login } })) },
    });
    const json = {
      data: {
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            node(1, '2026-10-02T10:00:00Z', [['someone', '2026-10-03T09:00:00Z'], ['work-login', '2026-10-02T12:00:00Z']]),
            node(2, '2026-10-02T15:00:00Z', [['work-ai-login', '2026-10-01T08:00:00Z']]),
            node(3, undefined, []),
          ],
        },
      },
    };
    const result = await new GithubSource(config(), fakeGh(SINGLE_SELECT, { json })).poll();

    expect('tickets' in result && result.tickets.map((t) => t.sortAt)).toEqual([Date.parse('2026-10-02T12:00:00Z'), Date.parse('2026-10-02T15:00:00Z'), null]);
    expect(ISSUES_QUERY).toContain('ProjectV2ItemFieldSingleSelectValue{ name updatedAt }');
    expect(ISSUES_QUERY).toContain('itemTypes:[ASSIGNED_EVENT, UNASSIGNED_EVENT]');
  });

  it("enters scope when the operator's current assignment began, ignoring status changes, unassigned spells and a second login's assignment (GC assignedSince)", async () => {
    type Event = [type: 'AssignedEvent' | 'UnassignedEvent', login: string, createdAt: string];
    const node = (number: number, assignees: string[], events: Event[]) => ({
      number,
      title: 'T',
      url: 'u',
      projectItems: { nodes: [{ project: { number: 3, owner: { login: 'acme' } }, fieldValueByName: { name: '⚒️ Dev', updatedAt: '2026-10-04T00:00:00Z' } }] },
      assignees: { nodes: assignees.map((login) => ({ login })) },
      timelineItems: { nodes: events.map(([__typename, login, createdAt]) => ({ __typename, createdAt, assignee: { login } })) },
    });
    const json = {
      data: {
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            // Assigned, unassigned, assigned again: the last assignment.
            node(1, ['work-login'], [['AssignedEvent', 'work-login', '2026-10-01T00:00:00Z'], ['UnassignedEvent', 'work-login', '2026-10-02T00:00:00Z'], ['AssignedEvent', 'Work-Login', '2026-10-03T00:00:00Z']]),
            // A second login added later keeps the first assignment; another person's assignment does not count.
            node(2, ['work-login', 'work-ai-login', 'someone'], [['AssignedEvent', 'work-login', '2026-10-01T00:00:00Z'], ['AssignedEvent', 'work-ai-login', '2026-10-02T00:00:00Z'], ['AssignedEvent', 'someone', '2026-10-03T00:00:00Z']]),
            // Not assigned to the operator, or the events start mid-assignment.
            node(3, ['someone'], [['AssignedEvent', 'someone', '2026-10-01T00:00:00Z']]),
            node(4, ['work-login'], []),
          ],
        },
      },
    };
    const result = await new GithubSource(config(), fakeGh(SINGLE_SELECT, { json })).poll();

    expect('tickets' in result && result.tickets.map((t) => t.enteredAt)).toEqual([Date.parse('2026-10-03T00:00:00Z'), Date.parse('2026-10-01T00:00:00Z'), null, null]);
    // The sort time is unchanged: the later of the latest assignment and the status change.
    expect('tickets' in result && result.tickets[0]?.sortAt).toBe(Date.parse('2026-10-04T00:00:00Z'));
    expect(ISSUES_QUERY).toContain('assignees(first:10){ nodes{ login } }');
  });

  it('without requireAssignee, searches the whole board and lists only issues in an assigned status, with no scope entry', async () => {
    const node = (number: number, project: number, status: string, assignee: string | null) => ({
      number,
      title: `Issue ${number}`,
      url: `u${number}`,
      projectItems: { nodes: [{ project: { number: project, owner: { login: 'acme' } }, fieldValueByName: { name: status, updatedAt: '2026-10-04T00:00:00Z' } }] },
      assignees: { nodes: assignee === null ? [] : [{ login: assignee }] },
      timelineItems: { nodes: assignee === null ? [] : [{ __typename: 'AssignedEvent', createdAt: '2026-10-01T00:00:00Z', assignee: { login: assignee } }] },
    });
    const json = {
      data: {
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          // Listed, whoever is assigned: an assigned status. Left out: an unconfigured status, and a configured status on another project.
          nodes: [node(1, 3, '⚒️ Dev', 'work-login'), node(2, 3, '⚒️ Dev', null), node(3, 3, '🔍 Review', 'someone'), node(4, 3, 'Backlog', 'work-login'), node(5, 4, '⚒️ Dev', 'work-login')],
        },
      },
    };
    const gh = fakeGh(SINGLE_SELECT, { json });
    const result = await new GithubSource(config({ requireAssignee: false }), gh).poll();
    const listed = (number: number) => ({ sourceKey: String(number), ref: `#${number}`, repo: 'acme/widgets', sourceId: null, title: `Issue ${number}`, url: `u${number}`, assigned: true, pool: false, sortAt: Date.parse('2026-10-04T00:00:00Z'), enteredAt: null, blockers: [] });

    expect(gh).toHaveBeenCalledWith(ISSUES_QUERY, { q: 'repo:acme/widgets is:issue is:open project:acme/3', status: 'Status' });
    expect(result).toEqual({ tickets: [listed(1), listed(2), listed(3)] });
  });

  it('with waitForBlockers, lists the open issues blocking each issue, by number in the configured repository and by full name in another (PRD R90)', async () => {
    const blocker = (number: number, state: string, repo: string) => ({ number, title: `Blocker ${number}`, url: `https://github.com/${repo}/issues/${number}`, state, repository: { nameWithOwner: repo } });
    const node = (number: number, blockedBy: unknown) => ({
      number,
      title: 'T',
      url: 'u',
      projectItems: { nodes: [{ project: { number: 3, owner: { login: 'acme' } }, fieldValueByName: { name: '⚒️ Dev' } }] },
      ...(blockedBy === undefined ? {} : { blockedBy }),
    });
    const json = {
      data: {
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            // GitHub lists closed blockers too; an unreadable one is null.
            node(1, { nodes: [blocker(12, 'OPEN', 'Acme/Widgets'), blocker(13, 'CLOSED', 'acme/widgets'), null, blocker(7, 'OPEN', 'acme/docs')] }),
            node(2, { nodes: [blocker(14, 'CLOSED', 'acme/widgets')] }),
            node(3, undefined),
          ],
        },
      },
    };
    const result = await new GithubSource(config({ waitForBlockers: true }), fakeGh(SINGLE_SELECT, { json })).poll();
    // Off, the default, no issue has blockers, so a stacked branch can start from its blocker's branch.
    const off = await new GithubSource(config(), fakeGh(SINGLE_SELECT, { json })).poll();

    expect('tickets' in off && off.tickets.map((t) => t.blockers)).toEqual([[], [], []]);
    expect('tickets' in result && result.tickets.map((t) => t.blockers)).toEqual([
      [
        { url: 'https://github.com/Acme/Widgets/issues/12', ref: '#12', title: 'Blocker 12' },
        { url: 'https://github.com/acme/docs/issues/7', ref: 'acme/docs#7', title: 'Blocker 7' },
      ],
      [],
      [],
    ]);
    expect(ISSUES_QUERY).toContain('blockedBy(first:50){ nodes{ number title url state repository{ nameWithOwner } } }');
  });

  it('treats a status on another project as not assigned', async () => {
    const result = await new GithubSource(config({ project: { owner: 'acme', number: 4, statusField: 'Status' } }), fakeGh(SINGLE_SELECT, { json: fixture('issues') })).poll();

    expect('tickets' in result && result.tickets.filter((t) => t.assigned)).toEqual([]);
  });

  it('follows pages and fails a read past the page limit', async () => {
    const page = (number: number, next: string | null) => ({
      json: {
        data: {
          search: {
            pageInfo: { hasNextPage: next !== null, endCursor: next },
            nodes: [{ number, title: 'T', url: 'u', projectItems: { nodes: [{ project: { number: 3, owner: { login: 'acme' } }, fieldValueByName: { name: '⚒️ Dev' } }] } }, {}],
          },
        },
      },
    });
    const gh = fakeGh(SINGLE_SELECT, page(1, 'c1'), page(2, null));
    const result = await new GithubSource(config({ maxPages: 2 }), gh).poll();

    expect(result).toEqual({ tickets: [expect.objectContaining({ sourceKey: '1', assigned: true }), expect.objectContaining({ sourceKey: '2', assigned: true })] });
    expect(gh.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ after: 'c1' }));
    expect(ISSUES_QUERY).toContain('search(query:$q, type:ISSUE, first:100, after:$after)');

    expect(await new GithubSource(config({ maxPages: 1 }), fakeGh(SINGLE_SELECT, page(1, 'c1'))).poll()).toEqual({ error: 'More than 1 pages of searched issues; raise sources.github.maxPages.' });
    const named = new GithubSource(config({ maxPages: 1 }), fakeGh(SINGLE_SELECT, page(1, 'c1')), undefined, 'widgets-dashboard');
    expect(named.name).toBe('widgets-dashboard');
    expect(await named.poll()).toEqual({ error: 'More than 1 pages of searched issues; raise sources.widgets-dashboard.maxPages.' });
  });

  it("fails the read when the configured project's status field is missing or not single-select, so no issue reads as unassigned", async () => {
    const field = (value: unknown): GhResult => ({ json: { data: { repositoryOwner: { projectV2: { field: value } } } } });
    const missing = 'Project acme/3 has no field named "Status". Set sources.github.project.statusField.';
    // gh exits 1 with this message when the project has no field of that name (mechanics M17).
    const notFound = 'gh: Could not resolve to a Unions::ProjectV2FieldConfiguration with the name Status';
    const poll = (...answers: GhResult[]) => new GithubSource(config(), fakeGh(...answers)).poll();

    expect(await poll({ error: notFound })).toEqual({ error: missing });
    expect(await poll({ error: `${notFound}\nAPI rate limit exceeded` })).toEqual({ error: `${notFound}\nAPI rate limit exceeded` });
    expect(await poll(field(null))).toEqual({ error: missing });
    expect(await poll(field({ __typename: 'ProjectV2Field' }))).toEqual({ error: 'The "Status" field on project acme/3 is a ProjectV2Field, not a single-select field.' });
    expect(await poll(field({}))).toEqual({ error: 'GitHub returned an unexpected response.' });
    expect(await poll({ json: { data: { repositoryOwner: null } } })).toEqual({ error: 'GitHub returned an unexpected response.' });

    const gh = fakeGh(SINGLE_SELECT, { json: fixture('issues') });

    expect(await new GithubSource(config(), gh).poll()).toEqual({ tickets: expect.any(Array) });
    expect(gh).toHaveBeenNthCalledWith(1, FIELD_QUERY, { owner: 'acme', number: 3, status: 'Status' });
    // Asking each issue's projects for the field would fail on any other project without it.
    expect(ISSUES_QUERY).not.toContain('field(name:');
  });

  describe('an assigned ticket the search leaves out or lists outside scope (PRD R88)', () => {
    const search = (...nodes: unknown[]): GhResult => ({ json: { data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
    const node = (number: number, status: string | null) => ({
      number,
      title: `Issue ${number}`,
      url: `https://github.com/acme/widgets/issues/${number}`,
      projectItems: { nodes: [{ project: { number: 3, owner: { login: 'acme' } }, fieldValueByName: status === null ? null : { name: status } }] },
      timelineItems: { nodes: [] },
    });
    const issue = (number: number, status: string, logins = ['work-login'], state = 'OPEN'): GhResult => ({
      json: {
        data: {
          repository: {
            issue: {
              id: `I${number}`, number, title: `Issue ${number}`, url: `https://github.com/acme/widgets/issues/${number}`, state, updatedAt: '2026-10-22T15:39:00Z',
              assignees: { nodes: logins.map((login) => ({ login })), pageInfo: { hasNextPage: false } },
              projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ project: { number: 3, owner: { login: 'acme' } }, fieldValueByName: { name: status } }] },
              timelineItems: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
            },
          },
        },
      },
    });
    const stored = (number: number, patch: Partial<Ticket> = {}): Ticket => ({ ...ticket(String(number)), title: `Stored ${number}`, url: `https://github.com/acme/widgets/issues/${number}`, sortAt: 1000 + number, ...patch });
    const kept = (number: number) => ({ sourceKey: String(number), ref: `#${number}`, repo: '', sourceId: null, title: `Stored ${number}`, url: `https://github.com/acme/widgets/issues/${number}`, assigned: true, pool: false, sortAt: 1000 + number, enteredAt: null, blockers: [] as TicketBlocker[] });

    it('reads each one on its own and keeps those still assigned, so an empty search ends no work item', async () => {
      const gh = fakeGh(
        SINGLE_SELECT,
        search(),
        issue(1, '🔍 Review'),
        issue(2, '🆕 New'),
        issue(3, '🔍 Review', ['someone']),
        issue(4, '🔍 Review', ['work-login'], 'CLOSED'),
        { error: 'gh: Could not resolve to an Issue with the number of 5.' },
        { json: { data: { repository: { issue: null } } } },
      );
      const current = [1, 2, 3, 4, 5, 6].map((number) => stored(number));

      expect(await new GithubSource(config(), gh).poll(current)).toEqual({ tickets: [kept(1)] });
      expect(gh).toHaveBeenNthCalledWith(3, ASSIGNMENT_QUERY, { owner: 'acme', name: 'widgets', number: 1, status: 'Status' });
      expect(gh).toHaveBeenCalledTimes(8);
    });

    it('replaces a search entry without a status with the stored ticket when the issue is still assigned, and reads no issue the search lists as assigned or the store holds as unassigned', async () => {
      // The search's blockers stay with the replacement (PRD R90).
      const blocked = { ...node(1, null), blockedBy: { nodes: [{ number: 12, title: 'Blocker 12', url: 'https://github.com/acme/widgets/issues/12', state: 'OPEN', repository: { nameWithOwner: 'acme/widgets' } }] } };
      const gh = fakeGh(SINGLE_SELECT, search(blocked, node(2, '⚒️ Dev'), node(3, '🆕 New'), node(4, null)), issue(1, '⚒️ Dev'), issue(4, '🆕 New'));
      const current = [stored(1), stored(2), stored(3, { assigned: false }), stored(4)];
      const result = await new GithubSource(config({ waitForBlockers: true }), gh).poll(current);

      expect(result).toEqual({ tickets: [{ ...kept(1), blockers: [{ url: 'https://github.com/acme/widgets/issues/12', ref: '#12', title: 'Blocker 12' }] }, expect.objectContaining({ sourceKey: '2', assigned: true }), expect.objectContaining({ sourceKey: '3', assigned: false }), expect.objectContaining({ sourceKey: '4', assigned: false, title: 'Issue 4' })] });
      expect(gh).toHaveBeenCalledTimes(4);
    });

    it('fails the poll when a read fails, so nothing changes', async () => {
      expect(await new GithubSource(config(), fakeGh(SINGLE_SELECT, search(), { error: 'GitHub is not reachable.' })).poll([stored(1)])).toEqual({ error: 'Could not confirm that #1 left the assigned state: GitHub is not reachable.' });
      expect(await new GithubSource(config(), fakeGh(SINGLE_SELECT, search(), { json: { data: {} } })).poll([stored(1)])).toEqual({ error: 'Could not confirm that #1 left the assigned state: GitHub returned unexpected assignment data.' });
      const mixed = 'gh: Could not resolve to an Issue with the number of 1.\nSomething went wrong while executing your query.';
      expect(await new GithubSource(config(), fakeGh(SINGLE_SELECT, search(), { error: mixed })).poll([stored(1)])).toEqual({ error: `Could not confirm that #1 left the assigned state: ${mixed}` });
      // A later failure fails the poll even after an earlier ticket was kept.
      expect(await new GithubSource(config(), fakeGh(SINGLE_SELECT, search(), issue(1, '⚒️ Dev'), { error: 'GitHub is not reachable.' })).poll([stored(1), stored(2)])).toEqual({ error: 'Could not confirm that #2 left the assigned state: GitHub is not reachable.' });
    });

    it('keeps the stored blockers of an issue missing from the search while waitForBlockers is on, and clears them while it is off (PRD R90)', async () => {
      const blocker = { url: 'https://github.com/acme/widgets/issues/12', ref: '#12', title: 'Blocker 12' };
      const poll = (waitForBlockers: boolean) => new GithubSource(config({ waitForBlockers }), fakeGh(SINGLE_SELECT, search(), issue(1, '⚒️ Dev'))).poll([stored(1, { blockers: [blocker] })]);

      const { blockers: _none, ...unread } = kept(1);

      expect(await poll(true)).toEqual({ tickets: [unread] });
      expect(await poll(false)).toEqual({ tickets: [kept(1)] });
    });

    it('without requireAssignee, keeps an issue in a configured status whoever is assigned', async () => {
      const gh = fakeGh(SINGLE_SELECT, search(), issue(1, '⚒️ Dev', ['someone']));
      expect(await new GithubSource(config({ requireAssignee: false }), gh).poll([stored(1)])).toEqual({ tickets: [kept(1)] });
    });
  });

  it('fails on a gh error or a malformed response', async () => {
    expect(await new GithubSource(config(), fakeGh(SINGLE_SELECT, { error: 'The GitHub CLI is not signed in. Run gh auth login.' })).poll()).toEqual({ error: 'The GitHub CLI is not signed in. Run gh auth login.' });
    expect(await new GithubSource(config(), fakeGh(SINGLE_SELECT, { json: { errors: [{ message: 'x' }] } })).poll()).toEqual({ error: 'GitHub returned an unexpected response.' });
  });
});

describe('GithubSource.context', () => {
  it('shows each comment author\'s roles from the roles file, matching the login in any case, and reads the file for each context', async () => {
    const json = JSON.parse(JSON.stringify(fixture('context-with-pr')).replaceAll('"user-a"', '"User-A"'));
    // The fixture's user-a wrote 5 issue comments, 2 pull request comments and 5 review-thread comments.
    const USER_A_HEADINGS = 12;
    const readRoles = vi.fn(async () => ({ roles: new Map([['user-a', ['tester', 'test-wrangler']]]) }));
    const source = new GithubSource(config({ rolesFile: '~/roster.json' }), fakeGh({ json }, { json }), readRoles);
    const result = await source.context(ticket('19504'));
    const text = (result as { context: string }).context;

    expect(readRoles).toHaveBeenCalledWith('~/roster.json');
    expect(result).not.toHaveProperty('warning');
    expect(text).toContain('### Last 5 pull request comments\n### User-A (tester, test-wrangler), 2026-09-10 12:01 [c11]\nComment starts here.');
    expect(text.match(/^### User-A[ ,]/gm)).toHaveLength(USER_A_HEADINGS);
    expect(text.match(/^### User-A \(tester, test-wrangler\), /gm)).toHaveLength(USER_A_HEADINGS);
    expect(text).toMatch(/^### user-[b-z], /m);

    readRoles.mockResolvedValueOnce({ roles: new Map([['user-a', ['dev']]]) });
    const again = ((await source.context(ticket('19504'))) as { context: string }).context;

    expect(again.match(/^### User-A \(dev\), /gm)).toHaveLength(USER_A_HEADINGS);
  });

  it('reads no roles without a roles file, and warns without roles when the file fails', async () => {
    const readRoles = vi.fn(async () => ({ error: 'Roles file r.json is not JSON.' }));
    const without = await new GithubSource(config(), fakeGh({ json: fixture('context-with-pr') }), readRoles).context(ticket('19504'));

    expect(readRoles).not.toHaveBeenCalled();
    expect(without).not.toHaveProperty('warning');

    const failed = await new GithubSource(config({ rolesFile: '/r.json' }), fakeGh({ json: fixture('context-with-pr') }), readRoles).context(ticket('19504'));

    expect(failed).toMatchObject({ context: (without as { context: string }).context, warning: 'Roles file r.json is not JSON. Comment authors show no roles.' });
  });

  it('formats the issue, history, last comments and the closing pull request, clipping each text', async () => {
    const gh = fakeGh({ json: fixture('context-with-pr') });
    const result = await new GithubSource(config(), gh).context(ticket('19504'));

    expect(gh).toHaveBeenCalledWith(CONTEXT_QUERY, { owner: 'acme', name: 'widgets', number: 19504, status: 'Status' });

    const text = (result as { context: string }).context;
    const lines = text.split('\n');

    expect(result).toMatchObject({ links: [{ label: 'Pull request #19515', target: 'https://github.com/acme/widgets/pull/19515' }] });

    expect(lines.slice(0, 6)).toEqual(['GitHub issue #19504: Issue 19504 [ticket]', 'https://github.com/acme/widgets/issues/19504', 'Board status: ⚒️ Dev', 'Assignees: work-login', '', '## Issue body']);
    expect(lines[6]).toBe("Issue body starts here.");
    expect(text).toContain('Issue body ends here.\n\n## Status and assignment history\n2026-09-07 12:18 user-b: status (none) → 🆕 New\n2026-09-07 12:18 user-a: status 🆕 New → 🔖 Planned\n2026-09-07 12:18 user-a: assigned user-a\n');
    expect(text.match(/\[…\d+ characters omitted…\]/g)).toEqual(['[…39262 characters omitted…]', '[…984 characters omitted…]', '[…50924 characters omitted…]', '[…8178 characters omitted…]', '[…1335 characters omitted…]']);
    expect(text.match(/^### .*, \d{4}-\d\d-\d\d \d\d:\d\d \[c\d+\]$/gm)).toHaveLength(5 + 5 + 10);
    expect(text).toContain('## Pull request #19515: Pull request 19515 [pr]\nhttps://github.com/acme/widgets/pull/19515\nAuthor: user-a. State: OPEN. Checks: SUCCESS. Head commit: user-a, 2026-09-22 14:50.\nYour submitted reviews and pull request comments: 3 comments, the latest 2026-10-02 20:58.\n\nPR body starts here.');
    expect(text).toContain('### Last 5 pull request comments\n### user-a, 2026-09-10 12:01 [c11]\nComment starts here.');
    expect(text).toContain('### Reviews\n2026-09-07 20:31 user-e: COMMENTED\n');
    expect(text).toContain('### Last 5 review threads\n\n#### Resolved thread\n### ');
    // The last issue comment is the latest activity; the recorded issue has no operator comment to leave out.
    expect(result).toMatchObject({ activityAt: Date.parse('2026-10-02T22:06:55Z') });
  });

  it('tags the issue, the pull request and each comment, numbering comments by time across sections, and returns their anchors (PRD R79)', async () => {
    const result = (await new GithubSource(config(), fakeGh({ json: fixture('context-with-pr') })).context(ticket('19504'))) as { context: string; anchors: Anchor[] };
    const issueUrl = 'https://github.com/acme/widgets/issues/19504';
    const prUrl = 'https://github.com/acme/widgets/pull/19515';

    // Review threads came first, then pull request comments, then issue comments, with one pull request comment among the issue's.
    expect(result.context.match(/\[c\d+\]$/gm)).toEqual([
      '[c15]', '[c16]', '[c17]', '[c19]', '[c20]',
      '[c11]', '[c12]', '[c13]', '[c14]', '[c18]',
      '[c1]', '[c6]', '[c2]', '[c7]', '[c3]', '[c8]', '[c4]', '[c9]', '[c5]', '[c10]',
    ]);
    expect(result.anchors).toHaveLength(22);
    expect(result.anchors.slice(0, 3)).toEqual([
      { id: 'ticket', url: issueUrl, page: 'ticket' },
      { id: 'pr', url: prUrl, page: 'pr' },
      { id: 'c1', url: `${prUrl}#discussion_r3952471066`, page: 'pr' },
    ]);
    expect(result.anchors.filter((anchor) => ['c10', 'c11', 'c18', 'c20'].includes(anchor.id))).toEqual([
      { id: 'c10', url: `${prUrl}#discussion_r3952610894`, page: 'pr' },
      { id: 'c11', url: `${prUrl}#issuecomment-5618353428`, page: 'pr' },
      { id: 'c18', url: `${prUrl}#issuecomment-5961368999`, page: 'pr' },
      { id: 'c20', url: `${issueUrl}#issuecomment-5962229582`, page: 'ticket' },
    ]);
  });

  it('numbers comments made at the same time in section order, issue comments first', async () => {
    type Node = { createdAt: string; url: string };
    const json = fixture('context-with-pr') as { data: { repository: { issue: { comments: { nodes: Node[] }; closedByPullRequestsReferences: { nodes: { comments: { nodes: Node[] } }[] } } } } };
    const issue = json.data.repository.issue;
    const prComment = issue.closedByPullRequestsReferences.nodes[0]!.comments.nodes[0]!;
    issue.comments.nodes[4]!.createdAt = prComment.createdAt;
    const result = (await new GithubSource(config(), fakeGh({ json })).context(ticket('19504'))) as { anchors: Anchor[] };

    expect(result.anchors.filter((anchor) => ['c11', 'c12'].includes(anchor.id))).toEqual([
      { id: 'c11', url: issue.comments.nodes[4]!.url, page: 'ticket' },
      { id: 'c12', url: prComment.url, page: 'pr' },
    ]);
  });

  it('gives an issue with no pull request no pr anchor, and leaves a comment without a URL untagged', async () => {
    const json = fixture('context-without-pr') as { data: { repository: { issue: { comments: { nodes: { url?: string }[] } } } } };
    delete json.data.repository.issue.comments.nodes[0]!.url;
    const result = (await new GithubSource(config(), fakeGh({ json })).context(ticket('18111'))) as { context: string; anchors: Anchor[] };

    expect(result.anchors.map((anchor) => [anchor.id, anchor.page])).toEqual([['ticket', 'ticket'], ['c1', 'ticket'], ['c2', 'ticket'], ['c3', 'ticket'], ['c4', 'ticket']]);
    expect(result.context).toContain('### user-f, 2026-08-10 15:59\n');
    expect(result.context).toContain('### user-g, 2026-09-07 09:18 [c1]\n');
  });

  it('leaves out the pull request section when no pull request closes the issue', async () => {
    const result = await new GithubSource(config(), fakeGh({ json: fixture('context-without-pr') })).context(ticket('18111'));
    const text = (result as { context: string }).context;

    expect(text.startsWith('GitHub issue #18111: Issue 18111 [ticket]\n')).toBe(true);
    expect(text).not.toContain('## Pull request');
    expect(result).toMatchObject({ links: [] });
    expect(text).toContain('## Last 5 comments');
  });

  it('takes the board status from the Status field and adds a field change the timeline did not log', async () => {
    const unlogged = (await new GithubSource(config(), fakeGh({ json: fixture('context-without-pr') })).context(ticket('18111'))) as { context: string };

    expect(unlogged.context).toContain('\nBoard status: 🎁 Assigned\n');
    expect(unlogged.context).toContain(
      '\n2026-10-02 22:57 work-login: assigned user-i\n2026-10-02 23:00 someone: status → 🎁 Assigned (no timeline event)\n2026-10-02 23:07 user-h: unassigned user-h\n',
    );

    const logged = (await new GithubSource(config(), fakeGh({ json: fixture('context-with-pr') })).context(ticket('19504'))) as { context: string };

    expect(logged.context).not.toContain('(no timeline event)');

    const json = fixture('context-without-pr') as { data: { repository: { issue: { projectItems: { nodes: unknown[] } } } } };
    json.data.repository.issue.projectItems.nodes = [];
    const offProject = (await new GithubSource(config(), fakeGh({ json })).context(ticket('18111'))) as { context: string };

    expect(offProject.context).toContain('\nBoard status: unknown\n');
    expect(offProject.context).not.toContain('(no timeline event)');
  });

  it('adds the field change only when it is more than a minute after the last status event, or no status event exists', async () => {
    type Issue = { projectItems: { nodes: { fieldValueByName: { updatedAt: string } }[] }; timelineItems: { nodes: { __typename: string }[] } };
    const contextAt = async (updatedAt: string, dropStatusEvents = false) => {
      const json = fixture('context-with-pr') as { data: { repository: { issue: Issue } } };
      const issue = json.data.repository.issue;
      issue.projectItems.nodes[1]!.fieldValueByName.updatedAt = updatedAt;

      if (dropStatusEvents) {
        issue.timelineItems.nodes = issue.timelineItems.nodes.filter((event) => event.__typename !== 'ProjectV2ItemStatusChangedEvent');
      }

      return ((await new GithubSource(config(), fakeGh({ json })).context(ticket('19504'))) as { context: string }).context;
    };

    expect(await contextAt('2026-09-22T14:56:13Z')).not.toContain('(no timeline event)');
    expect(await contextAt('2026-09-22T14:56:14Z')).toContain('\n2026-09-22 14:56 someone: status → ⚒️ Dev (no timeline event)');
    expect(await contextAt('2026-09-07T12:18:00Z', true)).toContain('\n2026-09-07 12:18 someone: status → ⚒️ Dev (no timeline event)\n');
  });

  it("reports the latest comment, review or head commit by anyone but the operator's logins, bots included, and not status or assignment changes (PRD R80)", async () => {
    const at = (minute: number) => `2026-10-14T14:${String(minute).padStart(2, '0')}:00Z`;
    const comment = (login: string, minute: number) => ({ body: 'x', createdAt: at(minute), url: `https://github.com/acme/widgets/issues/7#issuecomment-${minute}`, author: { login } });
    const review = (login: string, minute: number | null) => ({ state: 'COMMENTED', submittedAt: minute === null ? null : at(minute), author: { login } });
    const commit = (login: string | null, minute: number) => ({ commit: { committedDate: at(minute), author: { user: login === null ? null : { login } }, statusCheckRollup: null } });
    const pr = (reviews: object[], comments: object[], threads: object[], commits: object[] = []) => ({
      number: 8, title: 'P', url: 'https://github.com/acme/widgets/pull/8', state: 'OPEN', isDraft: false, updatedAt: at(0), body: '', author: { login: 'work-login' },
      reviewRequests: { nodes: [] }, comments: { nodes: comments }, commits: { nodes: commits }, reviews: { nodes: reviews }, reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: threads } }] },
    });
    const activityAt = async (comments: object[], closing: object | null = null) => {
      const issue = {
        number: 7, title: 'T', url: 'https://github.com/acme/widgets/issues/7', body: '', projectItems: { nodes: [] }, assignees: { nodes: [{ login: 'work-login' }] }, comments: { nodes: comments },
        timelineItems: { nodes: [{ __typename: 'AssignedEvent', createdAt: at(59), actor: { login: 'user-b' }, assignee: { login: 'work-login' } }] },
        closedByPullRequestsReferences: { nodes: closing === null ? [] : [closing] },
      };
      return ((await new GithubSource(config(), fakeGh({ json: { data: { repository: { issue } } } })).context(ticket('7'))) as { activityAt?: number | null }).activityAt;
    };

    expect(await activityAt([])).toBeNull();
    expect(await activityAt([comment('work-login', 10), comment('Work-AI-Login', 20)])).toBeNull();
    expect(await activityAt([comment('acme-gh-actions', 10), comment('work-login', 20)])).toBe(Date.parse(at(10)));
    expect(await activityAt([comment('user-a', 5)], pr([review('claude', 30), review('work-login', 40), review('user-c', null)], [comment('user-b', 12)], [comment('claude', 25)]))).toBe(Date.parse(at(30)));
    expect(await activityAt([comment('user-a', 5)], pr([], [comment('user-b', 12)], [comment('claude', 25), comment('work-login', 50)]))).toBe(Date.parse(at(25)));
    expect(await activityAt([comment('user-a', 5)], pr([], [comment('user-b', 42)], []))).toBe(Date.parse(at(42)));
    expect(await activityAt([comment('user-a', 5)], pr([], [comment('user-b', 12)], [], [commit('user-b', 44)]))).toBe(Date.parse(at(44)));
    expect(await activityAt([comment('user-a', 5)], pr([], [comment('user-b', 12)], [], [commit('WORK-LOGIN', 44)]))).toBe(Date.parse(at(12)));
    expect(await activityAt([], pr([], [], [], [commit(null, 46)]))).toBe(Date.parse(at(46)));
  });

  describe('bots and the operator\'s reviews', () => {
    const at = (minute: number) => `2026-10-29T12:${String(minute).padStart(2, '0')}:00Z`;
    const user = (login: string) => ({ __typename: 'User', login });
    const bot = (login: string) => ({ __typename: 'Bot', login });
    const comment = (author: object, minute: number) => ({ body: 'x', createdAt: at(minute), url: `https://github.com/acme/widgets/pull/8#issuecomment-${minute}`, author });
    const review = (author: object, minute: number) => ({ state: 'COMMENTED', submittedAt: at(minute), author });
    type Summary = { reviews?: object[]; comments?: object[]; reviewTotal?: number; commentTotal?: number };
    // The summary lists default to the shown ones; a test passes its own to show which lists the count reads.
    const contextOf = async (prAuthor: object, reviews: object[], comments: object[], threads: object[] = [], summary: Summary = {}) => {
      const summaryReviews = summary.reviews ?? reviews;
      const summaryComments = summary.comments ?? comments;
      const pr = {
        number: 8, title: 'P', url: 'https://github.com/acme/widgets/pull/8', state: 'OPEN', isDraft: false, updatedAt: at(0), body: 'PR body', author: prAuthor,
        reviewRequests: { nodes: [] }, comments: { nodes: comments }, commits: { nodes: [] }, reviews: { nodes: reviews }, reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: threads } }] },
        submittedReviews: { totalCount: summary.reviewTotal ?? summaryReviews.length, nodes: summaryReviews },
        allComments: { totalCount: summary.commentTotal ?? summaryComments.length, nodes: summaryComments },
      };
      const issue = {
        number: 7, title: 'T', url: 'https://github.com/acme/widgets/issues/7', body: '', projectItems: { nodes: [] }, assignees: { nodes: [{ login: 'work-login' }] }, comments: { nodes: [] },
        timelineItems: { nodes: [{ __typename: 'AssignedEvent', createdAt: at(59), actor: bot('acme-codebot'), assignee: { login: 'work-login' } }] },
        closedByPullRequestsReferences: { nodes: [pr] },
      };
      const readRoles = vi.fn(async () => ({ roles: new Map([['claude', ['dev']], ['user-a', ['dev']]]) }));
      return ((await new GithubSource(config({ rolesFile: '/r.json' }), fakeGh({ json: { data: { repository: { issue } } } }), readRoles).context(ticket('7'))) as { context: string }).context;
    };

    it('marks bot authors of reviews, comments, assignments and the pull request, before their roles', async () => {
      const text = await contextOf(bot('dependabot'), [review(bot('claude'), 43), review(user('user-a'), 50)], [comment(bot('github-actions'), 10)], [comment(bot('claude'), 43), comment(user('user-a'), 50)]);

      expect(text).toContain('\n2026-10-29 12:59 acme-codebot (bot): assigned work-login\n');
      expect(text).toContain('\nAuthor: dependabot (bot). State: OPEN.');
      expect(text).toContain('\n### github-actions (bot), 2026-10-29 12:10 [c1]\n');
      expect(text).toContain('\n### Reviews\n2026-10-29 12:43 claude (bot): COMMENTED\n2026-10-29 12:50 user-a: COMMENTED\n');
      expect(text).toContain('\n### claude (bot, dev), 2026-10-29 12:43 [c2]\n');
      expect(text).toContain('\n### user-a (dev), 2026-10-29 12:50 [c3]\n');
    });

    it('counts none when only a bot and the author reviewed somebody else\'s pull request', async () => {
      const text = await contextOf(user('user-a'), [review(bot('claude'), 43), review(user('user-a'), 50)], [comment(user('user-b'), 10)]);

      expect(text).toContain('\nAuthor: user-a. State: OPEN. Checks: none.\nYour submitted reviews and pull request comments: none.\n\nPR body');
    });

    it('counts the operator\'s reviews and comments under any of their logins, ignoring case, with the latest of each', async () => {
      const reviews = [review(user('work-login'), 30), review(bot('claude'), 45), review(user('Work-AI-Login'), 40), review(user('user-a'), 50)];
      const text = await contextOf(user('user-a'), reviews, [comment(user('work-login'), 5), comment(user('user-b'), 20)]);

      expect(text).toContain('\nYour submitted reviews and pull request comments: 2 reviews, the latest 2026-10-29 12:40; 1 comment, the latest 2026-10-29 12:05.\n');
      expect(await contextOf(user('user-a'), [], [comment(user('work-ai-login'), 5), comment(user('work-login'), 7)])).toContain('\nYour submitted reviews and pull request comments: 2 comments, the latest 2026-10-29 12:07.\n');
    });

    it('counts from the 100-item summary lists, not the shown last 5 comments and 20 reviews', async () => {
      const shown = [comment(user('user-b'), 20)];
      const text = await contextOf(user('user-a'), [review(user('user-a'), 50)], shown, [], { reviews: [review(user('work-login'), 15)], comments: [comment(user('work-ai-login'), 3), ...shown] });

      expect(text).toContain('\nYour submitted reviews and pull request comments: 1 review, the latest 2026-10-29 12:15; 1 comment, the latest 2026-10-29 12:03.\n');
      expect(await contextOf(user('user-a'), [review(user('work-login'), 15)], [comment(user('work-login'), 3)], [], { reviews: [], comments: [] })).toContain('comments: none.\n');
    });

    it('says which reviews and comments were not read when a summary list is cut and holds none of the operator\'s', async () => {
      const cut = await contextOf(user('user-a'), [review(bot('claude'), 43)], [comment(user('user-b'), 20)], [], { reviewTotal: 130 });

      expect(cut).toContain('\nYour submitted reviews and pull request comments: none in the last 1 of 130 reviews and last 1 of 1 comments; older ones were not read.\n');

      const found = await contextOf(user('user-a'), [review(user('work-login'), 43)], [], [], { commentTotal: 250 });

      expect(found).toContain('\nYour submitted reviews and pull request comments: 1 review, the latest 2026-10-29 12:43.\n');
    });

    it('leaves the count out on the operator\'s own pull request', async () => {
      const text = await contextOf(user('Work-Login'), [review(user('user-a'), 30)], []);

      expect(text).not.toContain('Your submitted reviews');
      expect(text).toContain('\nAuthor: Work-Login. State: OPEN. Checks: none.\n\nPR body');
    });
  });

  it('fails when the issue is missing, gh fails, or the response is malformed', async () => {
    expect(await new GithubSource(config(), fakeGh({ json: { data: { repository: { issue: null } } } })).context(ticket('7'))).toEqual({ error: 'Issue 7 was not found in acme/widgets.' });
    expect(await new GithubSource(config(), fakeGh({ error: 'boom' })).context(ticket('7'))).toEqual({ error: 'boom' });
    expect(await new GithubSource(config(), fakeGh({ json: { data: { repository: { issue: { number: 7 } } } } })).context(ticket('7'))).toEqual({ error: 'GitHub returned an unexpected response.' });
  });
});

describe('GithubSource.keyOfBranch', () => {
  it('reads the issue number from the branch pattern', () => {
    const source = new GithubSource(config(), fakeGh());

    expect(source.keyOfBranch('15619-fix-foo')).toBe('15619');
    expect(source.keyOfBranch('master')).toBeNull();
    expect(new GithubSource(config({ branchPattern: /^issue-(\d+)$/ }), fakeGh()).keyOfBranch('issue-12')).toBe('12');
  });
});

describe('GithubSource.ticketAt', () => {
  const answer = (state: string): GhResult => ({ json: { data: { repository: { issue: { number: 115, title: 'Snapshot wrapper', url: 'https://github.com/acme/widgets/issues/115', state } } } } });

  it('reads an issue of the configured repository in any spelling, and reports whether it is open (PRD R83)', async () => {
    const gh = fakeGh(answer('OPEN'), answer('CLOSED'));
    const source = new GithubSource(config(), gh);

    expect(await source.ticketAt('https://github.com/Acme/Widgets/issues/115/')).toEqual({ ticket: { sourceKey: '115', ref: '#115', repo: 'acme/widgets', title: 'Snapshot wrapper', url: 'https://github.com/acme/widgets/issues/115', open: true } });
    expect(gh).toHaveBeenCalledWith(ISSUE_QUERY, { owner: 'acme', name: 'widgets', number: 115 });
    expect(await source.ticketAt('https://github.com/acme/widgets/issues/115#issuecomment-1')).toMatchObject({ ticket: { open: false } });
  });

  it('answers null without a read for a pull request, another repository or another site', async () => {
    const source = new GithubSource(config(), fakeGh());

    for (const url of ['https://github.com/acme/widgets/pull/115', 'https://github.com/acme/other/issues/115', 'https://example.com/acme/widgets/issues/115', 'not a url']) {
      expect(await source.ticketAt(url)).toBeNull();
    }
  });

  it('names a number the repository has no issue for, passes other gh errors through, and fails a malformed response', async () => {
    const source = new GithubSource(config(), fakeGh({ error: 'gh: Could not resolve to an Issue with the number of 9.' }, { error: 'GitHub did not answer within 30 seconds.' }, { json: { data: { repository: { issue: null } } } }));

    expect(await source.ticketAt('https://github.com/acme/widgets/issues/9')).toEqual({ error: '#9 is not an issue in acme/widgets.' });
    expect(await source.ticketAt('https://github.com/acme/widgets/issues/9')).toEqual({ error: 'GitHub did not answer within 30 seconds.' });
    expect(await source.ticketAt('https://github.com/acme/widgets/issues/9')).toEqual({ error: 'GitHub returned an unexpected response.' });
  });
});

describe('GithubSource.checkLink', () => {
  const PR = 'https://github.com/acme/widgets/pull/20401';

  /** PR #20401: branch 19953-names-containing-html-run-as-script, closes acme/widgets#19953. */
  const pullRequest = (patch: { headRefName?: string; closes?: [number, string][]; more?: boolean } = {}): GhResult => {
    type Answer = { data: { repository: { pullRequest: { headRefName: string; closingIssuesReferences: { pageInfo: { hasNextPage: boolean }; nodes: unknown[] } } } } };
    const json = fixture('pull-request') as Answer;
    const pr = json.data.repository.pullRequest;
    pr.headRefName = patch.headRefName ?? pr.headRefName;
    pr.closingIssuesReferences.nodes = patch.closes?.map(([number, nameWithOwner]) => ({ number, repository: { nameWithOwner } })) ?? pr.closingIssuesReferences.nodes;
    pr.closingIssuesReferences.pageInfo.hasNextPage = patch.more ?? false;

    return { json };
  };

  it('accepts a pull request that closes the issue', async () => {
    const gh = fakeGh(pullRequest({ headRefName: 'feature-x' }));

    expect(await new GithubSource(config(), gh).checkLink(ticket('19953'), PR)).toEqual({ refused: null });
    expect(gh).toHaveBeenCalledWith(PULL_REQUEST_QUERY, { owner: 'acme', name: 'widgets', number: 20401 });
  });

  it('accepts a pull request whose branch names the issue but does not close it, as a stacked one', async () => {
    const source = new GithubSource(config(), fakeGh(pullRequest({ closes: [] })));

    expect(await source.checkLink(ticket('19953'), 'https://github.com/Acme/Widgets/pull/20401/files')).toEqual({ refused: null });
  });

  it("refuses a pull request that neither closes the issue nor has the issue's branch, in any spelling of its URL", async () => {
    const refused = 'Pull request #20401 does not close #20356 and its branch 19953-names-containing-html-run-as-script does not name it. Link only the pull request that delivers this work.';

    for (const target of [PR, 'http://github.com/acme/widgets/pull/20401', 'https://GitHub.com:443/acme/widgets/pull/20401#discussion']) {
      expect(await new GithubSource(config(), fakeGh(pullRequest())).checkLink(ticket('20356'), target)).toEqual({ refused });
    }
  });

  it('refuses a pull request that closes an issue of the same number in another repository', async () => {
    const source = new GithubSource(config(), fakeGh(pullRequest({ closes: [[20356, 'acme/other']] })));

    expect(await source.checkLink(ticket('20356'), PR)).toMatchObject({ refused: expect.stringContaining('does not close #20356') });
  });

  it('leaves the link unchecked when the pull request closes more issues than one read lists', async () => {
    const source = new GithubSource(config(), fakeGh(pullRequest({ more: true })));

    expect(await source.checkLink(ticket('20356'), PR)).toEqual({ error: 'pull request #20401 closes more issues than one read lists' });
  });

  it('refuses a pull request that does not exist', async () => {
    // gh's stderr for a missing pull request, recorded 2026-10-09; gh exits 1.
    const source = new GithubSource(config(), fakeGh({ error: 'gh: Could not resolve to a PullRequest with the number of 99999.' }));

    expect(await source.checkLink(ticket('20356'), 'https://github.com/acme/widgets/pull/99999')).toEqual({ refused: 'Pull request #99999 was not found in acme/widgets.' });
  });

  it('does not check an issue, another repository or another site', async () => {
    const source = new GithubSource(config(), fakeGh());

    for (const target of ['https://github.com/acme/widgets/issues/20401', 'https://github.com/acme/other/pull/1', 'https://github.com/acme/widgets-x/pull/1', 'https://example.com/acme/widgets/pull/1', 'https://github.com/acme/widgets/pull/1x', 'not a url']) {
      expect(await source.checkLink(ticket('20356'), target)).toEqual({ refused: null });
    }
  });

  it('returns an error when gh fails or the response is malformed', async () => {
    expect(await new GithubSource(config(), fakeGh({ error: 'boom' })).checkLink(ticket('20356'), PR)).toEqual({ error: 'boom' });
    expect(await new GithubSource(config(), fakeGh({ json: { data: { repository: { pullRequest: null } } } })).checkLink(ticket('20356'), PR)).toEqual({ error: 'GitHub returned an unexpected response.' });
  });
});
