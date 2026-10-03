import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ticket } from '@switchboard/core';
import { describe, expect, it, vi } from 'vitest';
import { parseGithubConfig } from '../src/config.js';
import type { GithubConfig } from '../src/config.js';
import type { Gh, GhResult } from '../src/gh.js';
import { CONTEXT_QUERY, ISSUES_QUERY } from '../src/queries.js';
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

const ticket = (sourceKey: string): Ticket => ({ id: 1, source: 'github', sourceKey, sourceId: null, title: '', url: '', assigned: true, lastPolledAt: null, repoRoot: '' });

describe('GithubSource.poll', () => {
  it('lists every searched issue, assigned only when its project status is configured', async () => {
    const gh = fakeGh({ json: fixture('issues') });
    const result = await new GithubSource(config(), gh).poll();

    expect(gh).toHaveBeenCalledWith(ISSUES_QUERY, { q: 'repo:acme/widgets is:issue is:open assignee:work-login assignee:work-ai-login project:acme/3', status: 'Status' });
    expect(result).toEqual({
      tickets: [20190, 20127, 19964, 19769, 19504, 19484, 19231, 19230, 18531, 18388, 18111].map((number) => ({
        sourceKey: String(number),
        sourceId: null,
        title: `Issue ${number}`,
        url: `https://github.com/acme/widgets/issues/${number}`,
        assigned: number !== 19231 && number !== 19230,
      })),
    });
  });

  it('treats a status on another project as not assigned', async () => {
    const result = await new GithubSource(config({ project: { owner: 'acme', number: 4, statusField: 'Status' } }), fakeGh({ json: fixture('issues') })).poll();

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
    const gh = fakeGh(page(1, 'c1'), page(2, null));
    const result = await new GithubSource(config({ maxPages: 2 }), gh).poll();

    expect(result).toEqual({ tickets: [expect.objectContaining({ sourceKey: '1', assigned: true }), expect.objectContaining({ sourceKey: '2', assigned: true })] });
    expect(gh.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ after: 'c1' }));
    expect(ISSUES_QUERY).toContain('search(query:$q, type:ISSUE, first:100, after:$after)');

    expect(await new GithubSource(config({ maxPages: 1 }), fakeGh(page(1, 'c1'))).poll()).toEqual({ error: 'More than 1 pages of assigned issues; raise sources.github.maxPages.' });
  });

  it('fails on a gh error or a malformed response', async () => {
    expect(await new GithubSource(config(), fakeGh({ error: 'The GitHub CLI is not signed in. Run gh auth login.' })).poll()).toEqual({ error: 'The GitHub CLI is not signed in. Run gh auth login.' });
    expect(await new GithubSource(config(), fakeGh({ json: { errors: [{ message: 'x' }] } })).poll()).toEqual({ error: 'GitHub returned an unexpected response.' });
  });
});

describe('GithubSource.context', () => {
  it('formats the issue, history, last comments and the closing pull request, clipping each text', async () => {
    const gh = fakeGh({ json: fixture('context-with-pr') });
    const result = await new GithubSource(config(), gh).context(ticket('19504'));

    expect(gh).toHaveBeenCalledWith(CONTEXT_QUERY, { owner: 'acme', name: 'widgets', number: 19504 });

    const text = (result as { context: string }).context;
    const lines = text.split('\n');

    expect(lines.slice(0, 6)).toEqual(['GitHub issue #19504: Issue 19504', 'https://github.com/acme/widgets/issues/19504', 'Board status: ⚒️ Dev', 'Assignees: work-login', '', '## Issue body']);
    expect(lines[6]).toBe("Issue body starts here.");
    expect(text).toContain('Issue body ends here.\n\n## Status and assignment history\n2026-09-07 12:18 user-b: status (none) → 🆕 New\n2026-09-07 12:18 user-a: status 🆕 New → 🔖 Planned\n2026-09-07 12:18 user-a: assigned user-a\n');
    expect(text.match(/\[…\d+ characters omitted…\]/g)).toEqual(['[…39262 characters omitted…]', '[…984 characters omitted…]', '[…50924 characters omitted…]', '[…8178 characters omitted…]', '[…1335 characters omitted…]']);
    expect(text.match(/^### .*, \d{4}-\d\d-\d\d \d\d:\d\d$/gm)).toHaveLength(5 + 5 + 10);
    expect(text).toContain('## Pull request #19515: Pull request 19515\nhttps://github.com/acme/widgets/pull/19515\nAuthor: user-a. State: OPEN. Checks: SUCCESS.\n\nPR body starts here.');
    expect(text).toContain('### Last 5 pull request comments\n### user-a, 2026-09-10 12:01\nComment starts here.');
    expect(text).toContain('### Reviews\n2026-09-07 20:31 user-e: COMMENTED\n');
    expect(text).toContain('### Last 5 review threads\n\n#### Resolved thread\n### ');
  });

  it('leaves out the pull request section when no pull request closes the issue', async () => {
    const result = await new GithubSource(config(), fakeGh({ json: fixture('context-without-pr') })).context(ticket('18111'));
    const text = (result as { context: string }).context;

    expect(text.startsWith('GitHub issue #18111: Issue 18111\n')).toBe(true);
    expect(text).not.toContain('## Pull request');
    expect(text).toContain('## Last 5 comments');
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
