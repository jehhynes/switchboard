import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Gh, GhResult } from '../src/gh.js';
import { PULL_NUMBER_STACK_QUERY, PULL_STACK_QUERY, readPullNumberStack, readPullStack } from '../src/stack.js';

/** Answers recorded from a published three-PR stack read from a second clone (mechanics M163), owner and repository scrubbed. */
function recorded(name: string): GhResult {
  return { json: JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'stack', `${name}.json`), 'utf8')) };
}

const target = (head: string) => ({ owner: 'owner', name: 'repo', head, headRepo: 'owner/repo' });

describe('readPullStack', () => {
  it('reads the open pull request and its whole stack, lowest first', async () => {
    const gh = vi.fn<Gh>(async () => recorded('open-stack'));
    const read = await readPullStack(gh, target('s2'));

    expect(gh).toHaveBeenCalledWith(PULL_STACK_QUERY, { owner: 'owner', name: 'repo', head: 's2' }, undefined);
    expect(read).toMatchObject({ state: 'found', pr: { number: 2, state: 'open', head: 's2', base: 's1', headSha: '4f47a242f3c842bfc892e2e91abf13aec6b8de91' } });
    expect(read.state === 'found' && read.stack).toEqual({
      number: 4,
      trunk: 'main',
      complete: true,
      members: [
        expect.objectContaining({ position: 1, number: 1, head: 's1', base: 'main', state: 'open' }),
        expect.objectContaining({ position: 2, number: 2, head: 's2', base: 's1' }),
        expect.objectContaining({ position: 3, number: 3, head: 's3', base: 's2' }),
      ],
    });
  });

  it('keeps merged and closed members with their states, the next one based on the trunk, and a deleted branch marked', async () => {
    const read = await readPullStack(async () => recorded('lifecycle-stack'), target('s2'));

    expect(read.state === 'found' && read.pr.base).toBe('main');
    expect(read.state === 'found' && read.stack?.members.map((one) => [one.head, one.state, one.branchDeleted])).toEqual([['s1', 'merged', true], ['s2', 'open', false], ['s3', 'closed', false]]);
  });

  it('answers several when GitHub has more open pull requests than it listed', async () => {
    const json = recorded('open-stack') as { json: { data: { repository: { open: { totalCount: number } } } } };

    json.json.data.repository.open.totalCount = 21;
    expect(await readPullStack(async () => json, target('s2'))).toEqual({ state: 'absent', several: true });
  });

  it('answers absent with the closed pull request for a branch whose only one is closed', async () => {
    expect(await readPullStack(async () => recorded('closed-only'), target('s3'))).toEqual({ state: 'absent', closed: expect.objectContaining({ number: 3, state: 'closed' }) });
  });

  it('answers a pull request in no stack with a null stack', async () => {
    expect(await readPullStack(async () => recorded('no-stack'), target('solo'))).toMatchObject({ state: 'found', pr: { number: 5, base: 's2' }, stack: null });
  });

  it('answers absent for a branch with no pull request', async () => {
    expect(await readPullStack(async () => recorded('no-pr'), target('nosuch'))).toEqual({ state: 'absent' });
  });

  it('ignores a pull request from another repository with the same branch name', async () => {
    expect(await readPullStack(async () => recorded('open-stack'), { ...target('s2'), headRepo: 'fork/repo' })).toEqual({ state: 'absent' });
  });

  it('answers absent with several when two open pull requests match', async () => {
    const json = recorded('open-stack') as { json: { data: { repository: { open: { nodes: unknown[] } } } } };
    const nodes = json.json.data.repository.open.nodes;

    nodes.push({ ...(nodes[0] as object), number: 9, baseRefName: 'main' });
    expect(await readPullStack(async () => json, target('s2'))).toEqual({ state: 'absent', several: true });
  });

  it('answers unavailable for a repository GitHub does not have, without stopping', async () => {
    const read = await readPullStack(async () => recorded('no-repo'), target('s2'));

    expect(read).toEqual({ state: 'unavailable', reason: "Could not resolve to a Repository with the name 'owner/no-such-repo-x'.", stop: false });
    expect(await readPullStack(async () => ({ json: { data: { repository: null } } }), target('s2'))).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('owner/repo') });
  });

  it('stops after a sign-in or rate-limit failure', async () => {
    expect(await readPullStack(async () => ({ error: 'The GitHub CLI is not signed in. Run gh auth login.' }), target('s2'))).toMatchObject({ state: 'unavailable', stop: true });
    expect(await readPullStack(async () => ({ error: 'GraphQL: API rate limit exceeded for user ID 1.' }), target('s2'))).toMatchObject({ state: 'unavailable', stop: true });
    expect(await readPullStack(async () => ({ error: 'Stopped before GitHub answered.' }), target('s2'))).toMatchObject({ state: 'unavailable', stop: false });
  });

  it('passes the signal to gh', async () => {
    const signal = new AbortController().signal;
    const gh = vi.fn<Gh>(async () => recorded('no-pr'));

    await readPullStack(gh, target('x'), signal);
    expect(gh.mock.calls[0]![2]).toBe(signal);
  });
});

describe('readPullNumberStack', () => {
  const byNumber = (name: string): GhResult => {
    const json = recorded(name) as { json: { data: { repository: { open: { nodes: unknown[] }; done: { nodes: unknown[] } } } } };
    const repository = json.json.data.repository;

    return { json: { data: { repository: { pullRequest: repository.open.nodes[0] ?? repository.done.nodes[0] ?? null } } } };
  };

  it('reads a linked open pull request with its stack', async () => {
    const gh = vi.fn<Gh>(async () => byNumber('open-stack'));
    const read = await readPullNumberStack(gh, { owner: 'owner', name: 'repo', number: 2 });

    expect(gh).toHaveBeenCalledWith(PULL_NUMBER_STACK_QUERY, { owner: 'owner', name: 'repo', number: 2 }, undefined);
    expect(read).toMatchObject({ state: 'found', pr: { number: 2 }, stack: { number: 4 } });
  });

  it('answers absent with a closed linked pull request, and absent for none', async () => {
    expect(await readPullNumberStack(async () => byNumber('closed-only'), { owner: 'owner', name: 'repo', number: 3 })).toMatchObject({ state: 'absent', closed: { number: 3 } });
    expect(await readPullNumberStack(async () => byNumber('no-pr'), { owner: 'owner', name: 'repo', number: 7 })).toEqual({ state: 'absent' });
  });
});
