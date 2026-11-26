import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Gh, GhResult } from '@switchboard/github';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { nodeGit } from '../src/changes.js';
import type { Git } from '../src/changes.js';
import { githubGhPath, githubRepo, MAX_LINKS, PageStack, pullLinkOf } from '../src/stack.js';
import type { PageStackDeps, StackView } from '../src/stack.js';
import type { WindowScope } from '../src/windows.js';
import { isolateGit, makeRepo } from './gitFixture.js';

beforeAll(() => isolateGit());

const gitTimeout = { timeout: process.platform === 'win32' ? 30_000 : 15_000 };

/** A repository whose git commands run at a clock the test moves, so reflog times are distinct. */
function stackRepo() {
  const repo = makeRepo({ 'a.txt': 'a\n' });
  let clock = 1_800_000_000;
  let held = false;
  const at = (cwd: string, ...args: string[]): string => {
    clock += held ? 0 : 10;

    return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: `${clock} +0000`, GIT_AUTHOR_DATE: `${clock} +0000` } });
  };
  const git = (...args: string[]) => at(repo.root, ...args);
  const commit = (name: string, cwd = repo.root) => {
    writeFileSync(join(cwd, `${name}.txt`), `${name}\n`);
    at(cwd, 'add', '-A');
    at(cwd, 'commit', '-qm', name);
  };
  const sha = (ref: string) => git('rev-parse', ref).trim();

  /** Runs `steps` with the clock stopped, so their reflog entries share one time. */
  const together = (steps: () => void) => {
    held = true;

    try {
      steps();
    } finally {
      held = false;
    }
  };

  return { root: repo.root, git, at, commit, sha, together };
}

const scope = (cwd: string, patch: Partial<WindowScope> = {}): WindowScope => ({ kind: 'page', key: 'p', folder: cwd, title: '', scopeGen: 1, conversations: [], workItemId: 7, cwd, sessionId: null, ...patch });

function page(cwd: string, patch: Partial<PageStackDeps> = {}) {
  let current = scope(cwd);

  return {
    stack: new PageStack({ isPage: (key) => key === 'p', scope: () => current, ...patch }),
    move: (next: Partial<WindowScope>) => (current = { ...current, ...next }),
  };
}

async function view(stack: PageStack, refresh = false): Promise<StackView> {
  const reply = await stack.stack('p', refresh ? '1' : null);

  expect(reply.status).toBe(200);
  return reply.body as StackView;
}

const names = (view: StackView) => view.links.map((link) => [link.name, link.relation, link.source]);

/** A GitHub answer for the current branch's pull request, shaped as the recorded ones (packages/github/test/fixtures/stack). */
function githubAnswer(pr: Record<string, unknown> | null, stack: Record<string, unknown>[] | null): GhResult {
  const pull = (one: Record<string, unknown>) => ({ state: 'OPEN', url: `https://github.com/o/r/pull/${String(one['number'])}`, isInMergeQueue: false, headRef: { name: one['headRefName'] }, headRepository: { nameWithOwner: 'o/r' }, ...one });

  return {
    json: {
      data: {
        repository: {
          open: { totalCount: pr === null ? 0 : 1, nodes: pr === null ? [] : [{ ...pull(pr), stack: stack === null ? null : { number: 4, baseRefName: 'main', entries: { pageInfo: { hasNextPage: false }, nodes: stack.map((one, index) => ({ position: index + 1, pullRequest: pull(one) })) } } }] },
          done: { nodes: [] },
        },
      },
    },
  };
}

describe('githubRepo', () => {
  it('reads owner and name from https and ssh remotes, and nothing from others', () => {
    expect(githubRepo('https://github.com/acme/widgets.git')).toEqual({ owner: 'acme', name: 'widgets' });
    expect(githubRepo('git@github.com:acme/widgets.git')).toEqual({ owner: 'acme', name: 'widgets' });
    expect(githubRepo('ssh://git@github.com/acme/widgets')).toEqual({ owner: 'acme', name: 'widgets' });
    expect(githubRepo('https://gitlab.com/acme/widgets.git')).toBeNull();
  });
});

describe('githubGhPath and pullLinkOf', () => {
  it("uses the ghPath of the GitHub source that reads the repository, else the default gh", () => {
    const sources = { work: { kind: 'github', options: { repo: 'Acme/Widgets', ghPath: '/opt/gh', logins: ['me'] } }, other: { kind: 'zoho', options: {} } } as never;

    expect(githubGhPath(sources, 'acme/widgets')).toBe('/opt/gh');
    expect(githubGhPath(sources, 'acme/else')).toBe('gh');
  });

  it("takes the newest pull request link a session reported, over one the ticket's text mentions", () => {
    const link = (target: string, reportedAt: number, mentioned: boolean) => ({ id: reportedAt, ticketId: 1, label: '', target, reportedAt, mentioned });
    const store = {
      workItem: (id: number) => (id === 7 ? { ticketId: 1 } : null),
      linksFor: () => [link('https://github.com/o/r/pull/1', 30, true), link('https://github.com/o/r/pull/2', 10, false), link('https://github.com/o/r/pull/3', 20, false), link('https://github.com/o/r/issues/4', 40, false)],
    };

    expect(pullLinkOf(store, 7)).toEqual({ owner: 'o', name: 'r', number: 3 });
    expect(pullLinkOf(store, 8)).toBeNull();
  });
});

describe('PageStack from the reflog', gitTimeout, () => {
  it("names a merge commit's paths against its first parent, so the tree's filter finds it by a path", async () => {
    const repo = stackRepo();

    repo.commit('w1');
    repo.git('checkout', '-q', '-b', 'side');
    repo.commit('s1');
    repo.git('checkout', '-q', 'work');
    repo.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');

    const result = await view(page(repo.root).stack);
    const merge = result.infos.find((one) => one.subject === 'merge side');

    expect(merge?.sha).toBe(repo.sha('work'));
    expect(merge?.files).toEqual(['s1.txt']);
  });

  it('follows branches created from other branches, measuring each against HEAD', async () => {
    const repo = stackRepo();

    repo.commit('w1');
    repo.git('checkout', '-q', '-b', 'mid');
    repo.commit('m1');
    repo.git('branch', 'top', 'mid');
    repo.git('checkout', '-q', 'top');
    repo.commit('t1');
    repo.commit('t2');

    const result = await view(page(repo.root).stack);

    expect(result.branch).toBe('top');
    expect(result.repo).toBe(basename(repo.root));
    expect(result.root).toBe(realpathSync(repo.root));
    expect(names(result)).toEqual([
      ['mid', 'below', 'reflog'],
      ['work', 'below', 'reflog'],
    ]);
    expect(result.commitIds).toEqual([repo.sha('top'), repo.sha('top~1')]);
    expect(result.infos.map((one) => one.files)).toEqual([['t2.txt'], ['t1.txt'], ['m1.txt'], ['w1.txt']]);
    expect(result.infos.map((one) => [one.sha, one.parent, one.subject])).toEqual([
      [repo.sha('top'), repo.sha('top~1'), 't2'],
      [repo.sha('top~1'), repo.sha('mid'), 't1'],
      [repo.sha('mid'), repo.sha('work'), 'm1'],
      [repo.sha('work'), repo.sha('work~1'), 'w1'],
    ]);
    expect(result.links[0]).toMatchObject({ forkPoint: repo.sha('mid'), behind: 0, commitIds: [repo.sha('mid')], actions: { expand: true, diffSince: true } });
    expect(result.links[1]).toMatchObject({ forkPoint: repo.sha('work'), commitIds: [repo.sha('work')] });
    expect(result.main).toMatchObject({ ref: 'origin/main', behind: 0 });
    expect(result.github.state).toBe('none');
    expect(result.incomplete).toBe(false);
  });

  it('counts the commits a base gained since as behind', async () => {
    const repo = stackRepo();

    repo.git('checkout', '-q', '-b', 'child');
    repo.commit('c1');
    repo.git('checkout', '-q', 'work');
    repo.commit('w1');
    repo.commit('w2');
    repo.git('checkout', '-q', 'child');

    const result = await view(page(repo.root).stack);

    expect(result.links[0]).toMatchObject({ name: 'work', behind: 2, forkPoint: repo.sha('child~1') });
  });

  it('never lists a sibling created from the same base', async () => {
    const repo = stackRepo();

    repo.git('branch', 'sibling', 'work');
    repo.git('checkout', '-q', '-b', 'mine', 'work');
    repo.commit('m1');

    expect(names(await view(page(repo.root).stack))).toEqual([['work', 'below', 'reflog']]);
  });

  it('marks a link unknown after the child was rebased onto something else', async () => {
    const repo = stackRepo();

    repo.git('branch', 'other', 'work');
    repo.git('checkout', '-q', 'other');
    repo.commit('o1');
    repo.git('checkout', '-q', '-b', 'child', 'work');
    repo.commit('c1');
    repo.git('checkout', '-q', 'work');
    repo.commit('w1');
    repo.git('checkout', '-q', 'child');
    repo.git('rebase', '-q', 'other');

    const result = await view(page(repo.root).stack);

    expect(result.links).toEqual([]);
    expect(result.incomplete).toBe(true);
  });

  it('follows a parent renamed since, and refuses a name another branch was renamed into', async () => {
    const repo = stackRepo();

    repo.git('checkout', '-q', '-b', 'old');
    repo.commit('o1');
    repo.git('checkout', '-q', '-b', 'child');
    repo.commit('c1');
    repo.git('branch', '-m', 'old', 'renamed');

    expect(names(await view(page(repo.root).stack))[0]).toEqual(['renamed', 'below', 'reflog']);

    const second = stackRepo();

    second.git('checkout', '-q', '-b', 'parent');
    second.commit('p1');
    second.git('checkout', '-q', '-b', 'child');
    second.commit('c1');
    second.git('branch', '-m', 'parent', 'moved');
    second.git('branch', 'decoy', 'work');
    second.git('branch', '-m', 'decoy', 'parent');

    const result = await view(page(second.root).stack);

    expect(result.links).toEqual([]);
    expect(result.incomplete).toBe(true);
  });

  it('ends at the remote default branch for a branch created from it, and reads no chain when detached', async () => {
    const repo = stackRepo();

    repo.git('checkout', '-q', '-b', 'fresh', 'origin/main');
    repo.commit('f1');

    const result = await view(page(repo.root).stack);

    expect(result.links).toEqual([]);
    expect(result.incomplete).toBe(false);
    expect(result.commitIds).toEqual([repo.sha('fresh')]);

    repo.git('checkout', '-q', '--detach');
    expect(await view(page(repo.root).stack)).toMatchObject({ branch: null, links: [] });
  });

  it('refuses two checkouts into the branch at its creation time from different branches', async () => {
    const repo = stackRepo();

    repo.git('branch', 'other', 'work');
    repo.together(() => {
      repo.git('checkout', '-q', '-b', 'child');
      repo.git('checkout', '-q', 'other');
      repo.git('checkout', '-q', 'child');
    });
    repo.commit('c1');

    const result = await view(page(repo.root).stack);

    expect(result.links).toEqual([]);
    expect(result.incomplete).toBe(true);
  });

  it('keeps a link whose fork point is outside the range starts, with diff since off, as incomplete', async () => {
    const repo = stackRepo();

    repo.git('branch', 'old', 'work');
    repo.commit('w1');
    repo.git('update-ref', 'refs/remotes/origin/main', 'work');
    repo.git('branch', 'child', 'old');
    repo.git('checkout', '-q', 'child');
    repo.git('reset', '-q', '--hard', 'work');
    repo.commit('c1');

    const result = await view(page(repo.root).stack);

    expect(result.links[0]).toMatchObject({ name: 'old', forkPoint: null, actions: { diffSince: false, expand: false } });
    expect(result.incomplete).toBe(true);
    expect(result.commitIds).toEqual([repo.sha('child')]);
  });

  it('gives two branches at one commit their own behind counts', async () => {
    const repo = stackRepo();

    repo.git('checkout', '-q', '-b', 'a');
    repo.commit('a1');
    repo.git('branch', 'b', 'a');
    repo.git('checkout', '-q', 'work');
    repo.commit('w1');
    repo.git('checkout', '-q', 'a');

    const onA = await view(page(repo.root).stack);

    repo.git('checkout', '-q', 'b');

    const onB = await view(page(repo.root).stack);

    expect(onA.links[0]).toMatchObject({ name: 'work', behind: 1 });
    expect(onB.links[0]).toMatchObject({ name: 'a', behind: 0 });
  });

  it('stops at a cycle, marking the stack incomplete', async () => {
    const repo = stackRepo();
    const common = repo.git('rev-parse', '--git-common-dir').trim();

    repo.git('checkout', '-q', '-b', 'a');
    repo.commit('a1');
    repo.git('checkout', '-q', '-b', 'b');
    repo.commit('b1');
    // Make a's recorded origin b, as a reflog edited by hand would.
    writeFileSync(join(repo.root, common, 'logs', 'refs', 'heads', 'a'), `${'0'.repeat(40)} ${repo.sha('a')} T <t@e> 1800000001 +0000\tbranch: Created from b\n`);

    const result = await view(page(repo.root).stack);

    expect(names(result)).toEqual([['a', 'below', 'reflog']]);
    expect(result.incomplete).toBe(true);
  });

  it(`follows at most ${MAX_LINKS} links`, async () => {
    const repo = stackRepo();

    for (let index = 0; index <= MAX_LINKS + 1; index++) {
      repo.git('checkout', '-q', '-b', `s${index}`);
      repo.commit(`s${index}`);
    }

    const result = await view(page(repo.root).stack);

    expect(result.links).toHaveLength(MAX_LINKS);
    expect(result.incomplete).toBe(true);
  });

  it('shows a missing upstream, a deleted base branch and the linked worktree last fetch', async () => {
    const repo = stackRepo();
    const other = mkdtempSync(join(tmpdir(), 'sb-wt-'));

    repo.git('checkout', '-q', '-b', 'base');
    repo.commit('b1');
    repo.git('update-ref', 'refs/remotes/origin/base', 'HEAD');
    repo.git('remote', 'add', 'origin', 'https://example.invalid/r.git');
    repo.git('config', 'branch.base.remote', 'origin');
    repo.git('config', 'branch.base.merge', 'refs/heads/base');
    repo.git('update-ref', '-d', 'refs/remotes/origin/base');
    repo.git('worktree', 'add', '-q', '-b', 'child', join(other, 'wt'), 'base');
    repo.commit('c1', join(other, 'wt'));

    const fetchHead = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD'], { cwd: join(other, 'wt'), encoding: 'utf8' }).trim();

    writeFileSync(fetchHead, '');
    utimesSync(fetchHead, 1_800_000_000, 1_800_000_000);

    const workItemAt = vi.fn((path: string) => (path === repo.root ? { id: 3, title: 'Base work' } : null));
    const result = await view(page(join(other, 'wt'), { workItemAt }).stack);

    expect(result.links[0]).toMatchObject({ name: 'base', upstreamMissing: true, branchDeleted: false, workItem: { id: 3, title: 'Base work' } });
    expect(result.main.fetchedAt).toBe(1_800_000_000_000);
  });
});

describe('PageStack from GitHub', gitTimeout, () => {
  /** A repository with `origin` on GitHub and the stack s1 ← s2 ← s3 checked out at s2. */
  function github() {
    const repo = stackRepo();

    repo.git('remote', 'add', 'origin', 'https://github.com/o/r.git');

    for (const name of ['s1', 's2', 's3']) {
      repo.git('checkout', '-q', '-b', name);
      repo.commit(name);
    }

    repo.git('checkout', '-q', 's2');
    return repo;
  }

  const member = (repo: ReturnType<typeof stackRepo>, number: number, head: string, base: string, patch: Record<string, unknown> = {}) => ({ number, headRefName: head, headRefOid: repo.sha(head), baseRefName: base, ...patch });

  it("takes the whole order from GitHub's stack, over the reflog, with members above as summary rows", async () => {
    const repo = github();

    // The reflog says s2 came from s1; GitHub's stack puts s3 between them, so GitHub wins.
    repo.git('checkout', '-q', 's1');
    repo.git('checkout', '-q', 's2');

    const gh = vi.fn<Gh>(async () => githubAnswer(member(repo, 2, 's2', 's1'), [member(repo, 1, 's1', 'main'), member(repo, 2, 's2', 's1'), member(repo, 3, 's3', 's2')]));
    const result = await view(page(repo.root, { gh: () => gh }).stack);

    expect(gh).toHaveBeenCalledTimes(1);
    expect(gh.mock.calls[0]![1]).toEqual({ owner: 'o', name: 'r', head: 's2' });
    expect(names(result)).toEqual([
      ['s1', 'below', 'github-stack'],
      ['s3', 'above', 'github-stack'],
    ]);
    expect(result.links[0]).toMatchObject({ pr: { number: 1, state: 'open' }, tip: repo.sha('s1'), tipSource: 'github', forkPoint: repo.sha('s1'), actions: { diffSince: true } });
    // s3 holds s2's commits plus its own, so it lacks none of s2's; it has no comparison actions.
    expect(result.links[1]).toMatchObject({ lacks: 0, actions: { expand: false, diffSince: false }, commitIds: [] });
    expect(result.github).toMatchObject({ state: 'fresh' });
  });

  it("finds a fork's pull request in upstream with origin's owner as head", async () => {
    const repo = github();

    repo.git('remote', 'set-url', 'origin', 'git@github.com:me/r.git');
    repo.git('remote', 'add', 'upstream', 'https://github.com/o/r');

    const gh = vi.fn<Gh>(async () => githubAnswer(null, null));

    await view(page(repo.root, { gh: () => gh }).stack);
    expect(gh.mock.calls[0]![1]).toEqual({ owner: 'o', name: 'r', head: 's2' });
  });

  it("reads the work item's linked pull request first", async () => {
    const repo = github();
    const gh = vi.fn<Gh>(async () => ({ json: { data: { repository: { pullRequest: null } } } }));

    await view(page(repo.root, { gh: () => gh, pullLink: (id) => (id === 7 ? { owner: 'o', name: 'r', number: 12 } : null) }).stack);
    expect(gh.mock.calls[0]![1]).toEqual({ owner: 'o', name: 'r', number: 12 });
  });

  it('uses the pull request base when it is in no stack, outranking the reflog', async () => {
    const repo = github();

    // The reflog says s2 came from s1; its pull request targets work.
    const result = await view(page(repo.root, { gh: () => async () => githubAnswer(member(repo, 2, 's2', 'work'), null) }).stack);

    expect(names(result)[0]).toEqual(['work', 'below', 'pr-base']);
  });

  it('measures a pull request base this clone has only as a remote branch, and never calls a missing one deleted', async () => {
    const repo = github();

    repo.git('update-ref', 'refs/remotes/origin/parent', 's1');
    repo.git('branch', '-D', 's1');

    const result = await view(page(repo.root, { gh: () => async () => githubAnswer(member(repo, 2, 's2', 'parent'), null) }).stack);

    expect(result.links[0]).toMatchObject({ name: 'parent', source: 'pr-base', tip: repo.sha('origin/parent'), forkPoint: repo.sha('origin/parent'), branchDeleted: false, notInClone: false });

    const gone = await view(page(repo.root, { gh: () => async () => githubAnswer(member(repo, 2, 's2', 'elsewhere'), null) }).stack);

    expect(gone.links[0]).toMatchObject({ name: 'elsewhere', tip: null, branchDeleted: false, notInClone: true, actions: { diffSince: false } });
  });

  it("reads a fork's remote-only base from the remote of the repository its pull request targets", async () => {
    const repo = github();

    repo.git('remote', 'set-url', 'origin', 'https://github.com/me/r.git');
    repo.git('remote', 'add', 'upstream', 'https://github.com/o/r.git');
    repo.git('update-ref', 'refs/remotes/origin/parent', 'work');
    repo.git('update-ref', 'refs/remotes/upstream/parent', 's1');

    const result = await view(page(repo.root, { gh: () => async () => githubAnswer(member(repo, 2, 's2', 'parent', { headRepository: { nameWithOwner: 'me/r' } }), null) }).stack);

    expect(result.links[0]).toMatchObject({ name: 'parent', source: 'pr-base', tip: repo.sha('s1') });
  });

  it('reads GitHub again for the new repository when a remote changes', async () => {
    const repo = github();
    const gh = vi.fn<Gh>(async () => githubAnswer(null, null));
    const { stack } = page(repo.root, { gh: () => gh });

    await view(stack);
    repo.git('remote', 'set-url', 'origin', 'https://github.com/other/r.git');
    await view(stack);
    expect(gh.mock.calls.map((call) => call[1]['owner'])).toEqual(['o', 'other']);
  });

  it('keeps merged members, marks deleted branches and members this clone lacks', async () => {
    const repo = github();
    const missing = 'f'.repeat(40);

    repo.git('branch', 'gone-local', 's1');

    const answer = githubAnswer(member(repo, 2, 's2', 'main'), [member(repo, 1, 's1', 'main', { state: 'MERGED', headRef: null }), member(repo, 2, 's2', 'main'), { number: 3, headRefName: 's3', headRefOid: missing, baseRefName: 's2' }]);
    const result = await view(page(repo.root, { gh: () => async () => answer }).stack);

    expect(result.links[0]).toMatchObject({ name: 's1', pr: { state: 'merged' }, branchDeleted: true });
    expect(result.links[1]).toMatchObject({ name: 's3', relation: 'above', notInClone: true, tip: null, lacks: null, localDiffers: true });
  });

  it('labels a merged or closed current pull request and falls to the reflog, labelled as such', async () => {
    const repo = github();
    const closed: GhResult = { json: { data: { repository: { open: { totalCount: 0, nodes: [] }, done: { nodes: [{ ...member(repo, 2, 's2', 's1'), state: 'MERGED', url: 'u', headRef: null, headRepository: { nameWithOwner: 'o/r' } }] } } } } };
    const result = await view(page(repo.root, { gh: () => async () => closed }).stack);

    expect(result.pr).toEqual({ number: 2, state: 'merged', url: 'u' });
    expect(names(result)[0]).toEqual(['s1', 'below', 'reflog']);
  });

  it('answers pending when GitHub is slow, then uses its answer on the next read', async () => {
    const repo = github();
    let answer: (value: GhResult) => void = () => {};
    const gh = vi.fn<Gh>(() => new Promise((resolve) => (answer = resolve)));
    const { stack } = page(repo.root, { gh: () => gh });
    const first = await view(stack);

    expect(first.github.state).toBe('pending');
    expect(names(first)[0]).toEqual(['s1', 'below', 'reflog']);

    answer(githubAnswer(member(repo, 2, 's2', 'work'), null));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await view(stack);

    expect(second.github.state).toBe('fresh');
    expect(names(second)[0]).toEqual(['work', 'below', 'pr-base']);
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it('uses a kept observation as stale when GitHub later fails, and holds off after a sign-in failure', async () => {
    const repo = github();
    let now = 1_000_000;
    const answers: GhResult[] = [githubAnswer(member(repo, 2, 's2', 'work'), null), { error: 'The GitHub CLI is not signed in. Run gh auth login.' }];
    const gh = vi.fn<Gh>(async () => answers.shift()!);
    const { stack } = page(repo.root, { gh: () => gh, now: () => now });

    await view(stack);
    now += 6 * 60_000;

    const stale = await view(stack);

    expect(stale.github).toEqual({ state: 'stale', observedAt: 1_000_000, reason: 'The GitHub CLI is not signed in. Run gh auth login.' });
    expect(names(stale)[0]).toEqual(['work', 'below', 'pr-base']);

    now += 1_000;
    await view(stack);
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it('answers unavailable with the reason and falls to the reflog with no observation', async () => {
    const repo = github();
    const result = await view(page(repo.root, { gh: () => async () => ({ error: 'GitHub did not answer.' }) }).stack);

    expect(result.github).toEqual({ state: 'unavailable', observedAt: null, reason: 'GitHub did not answer.' });
    expect(names(result)[0]).toEqual(['s1', 'below', 'reflog']);
  });

  it('skips GitHub for a repository with no GitHub remote', async () => {
    const repo = stackRepo();
    const gh = vi.fn<Gh>();

    repo.git('remote', 'add', 'origin', 'https://gitlab.com/o/r.git');
    expect((await view(page(repo.root, { gh: () => gh }).stack)).github.state).toBe('none');
    expect(gh).not.toHaveBeenCalled();
  });
});

describe('PageStack caching and refusals', gitTimeout, () => {
  it('answers again from its cache until git changes, and Refresh reads again', async () => {
    const repo = stackRepo();
    const calls: string[][] = [];
    const git: Git = (args, cwd, options) => (calls.push(args), nodeGit(args, cwd, options));

    repo.git('checkout', '-q', '-b', 'child');
    repo.commit('c1');

    const { stack } = page(repo.root, { git });
    const first = await view(stack);
    const reads = () => calls.filter((args) => args[0] === 'log' && args[1] === '-g').length;
    const before = reads();

    const commands = calls.length;

    expect(await view(stack)).toEqual(first);
    expect(reads()).toBe(before);
    // A cache hit costs the state key's four git commands, and reads nothing of the history.
    expect(calls.slice(commands).map((args) => args[0])).toEqual(['rev-parse', 'for-each-ref', 'rev-parse', 'config']);

    // Switching to another branch at the same commit changes the key.
    repo.git('checkout', '-q', '-b', 'twin');
    expect((await view(stack)).branch).toBe('twin');

    const settled = reads();

    await view(stack, true);
    expect(reads()).toBeGreaterThan(settled);
  });

  it('reads again when the remote default branch moves', async () => {
    const repo = stackRepo();

    repo.git('checkout', '-q', '-b', 'child');
    repo.commit('c1');

    const { stack } = page(repo.root);

    expect((await view(stack)).main.behind).toBe(0);
    repo.git('checkout', '-q', 'work');
    repo.commit('w1');
    repo.git('update-ref', 'refs/remotes/origin/main', 'work');
    repo.git('checkout', '-q', 'child');
    expect((await view(stack)).main.behind).toBe(1);
  });

  it('shares one read between requests for the same state', async () => {
    const repo = stackRepo();
    let reads = 0;
    const git: Git = (args, cwd, options) => ((reads += args[0] === 'worktree' ? 1 : 0), nodeGit(args, cwd, options));
    const { stack } = page(repo.root, { git });

    await Promise.all([stack.stack('p'), stack.stack('p')]);
    expect(reads).toBe(1);
  });

  it('refuses another page, a conversation without a folder, and one that changed during the read', async () => {
    const repo = stackRepo();
    const { stack, move } = page(repo.root);

    expect((await stack.stack('other')).status).toBe(403);
    move({ cwd: null });
    expect(await stack.stack('p')).toMatchObject({ status: 409, body: { error: 'This conversation has no folder yet.' } });
    move({ cwd: repo.root });

    const reading = stack.stack('p');

    move({ scopeGen: 2 });
    expect(await reading).toMatchObject({ status: 409, body: { error: "The window's conversation changed." } });
  });
});
