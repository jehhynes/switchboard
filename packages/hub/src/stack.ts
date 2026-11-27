import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Link, SourceSettings } from '@switchboard/core';
import { readPullNumberStack, readPullStack } from '@switchboard/github';
import type { Gh, PullStack, PullStackRead, StackPull } from '@switchboard/github';
import { BASE_REFS, etagOf, nodeGit } from './changes.js';
import type { ChangesReply, Git } from './changes.js';
import { outOfScope } from './windows.js';
import type { WindowScope } from './windows.js';

/**
 * The Changes tab's stacked bases (PRD R128, architecture.md § Web page, Changes): the branches the current branch was stacked on, found only
 * from what was recorded, in this order: GitHub's native stack, the pull request's base, the local reflog, then the remote default branch.
 * Ancestry only measures each recorded link; nothing is fetched.
 */

export type LinkSource = 'github-stack' | 'pr-base' | 'reflog' | 'unknown';

export interface StackLink {
  name: string;
  /** Below the current branch (a base), or above it in a GitHub stack. */
  relation: 'below' | 'above';
  source: LinkSource;
  pr?: { number: number; state: StackPull['state']; url: string };
  /** The commit the link is measured at, and where it came from; null when this clone does not have it. */
  tip: string | null;
  tipSource: 'local' | 'github' | null;
  /** Where the current branch left this link, when that is a commit the range routes accept; else null and the link is incomplete. */
  forkPoint: string | null;
  /** Commits this link has that the current branch lacks (below), or that the current branch has and it lacks (above, `lacks`). */
  behind: number | null;
  lacks?: number | null;
  upstreamMissing: boolean;
  branchDeleted: boolean;
  /** The link's GitHub commit is not in this clone. */
  notInClone: boolean;
  /** A local branch of this name is at another commit than GitHub's. */
  localDiffers: boolean;
  workItem?: { id: number; title: string };
  /** The current branch's commits that sit on this link: from the next link's fork point to this one's, newest first. */
  commitIds: string[];
  more: boolean;
  actions: { expand: boolean; diffSince: boolean };
}

export type GithubState = 'fresh' | 'stale' | 'unavailable' | 'pending' | 'none';

export interface StackView {
  /** The repository's name, its main checkout's folder name, and the worktree's top folder. */
  repo: string;
  root: string;
  /** The current branch, null when HEAD is detached. */
  branch: string | null;
  head: string;
  /** The current branch's own commits, from its nearest base's fork point, newest first. */
  commitIds: string[];
  /** Each listed commit's first parent, subject and author and committer dates, for commits past the `changes` answer's 200, and the paths it changes, at most {@link MAX_INFO_FILES}, so the tree's filter finds a commit by a file. */
  infos: { sha: string; parent: string | null; subject: string; authored: number; committed: number; time: number; files: string[] }[];
  more: boolean;
  /** A link was unknown, could not be measured, or the chain hit its bound. */
  incomplete: boolean;
  github: { state: GithubState; observedAt: number | null; reason?: string };
  /** The current branch's pull request when it is merged or closed, so the tree can say so. */
  pr?: { number: number; state: StackPull['state']; url: string };
  links: StackLink[];
  main: { ref: string | null; behind: number | null; fetchedAt: number | null };
}

/** The most links followed below the current branch, and the most commit IDs listed per link. */
export const MAX_LINKS = 10;
export const MAX_LINK_COMMITS = 200;
export const MAX_INFO_FILES = 300;
/** How long a GitHub observation is used, the whole GitHub phase may take, and the route waits for it before answering `pending`. */
export const GITHUB_KEPT_MS = 5 * 60_000;
export const GITHUB_DEADLINE_MS = 3_000;
export const GITHUB_WAIT_MS = 800;
/** How long a sign-in or rate-limit failure holds off the next GitHub read, unless the page refreshes. */
export const GITHUB_STOP_MS = 60_000;

const SHA = /^[0-9a-f]{40,64}$/;

export interface PageStackDeps {
  isPage(key: string): boolean;
  scope(key: string): WindowScope | null;
  git?: Git;
  /** gh for a repository (`owner/name`): the `ghPath` of the GitHub source that covers it, else the default sign-in; null for no GitHub reads. */
  gh?(repo: string): Gh | null;
  /** The work item's verified pull request link (PRD R52), when it has one. */
  pullLink?(workItemId: number): { owner: string; name: string; number: number } | null;
  /** The work item whose linked worktree is at `path`. */
  workItemAt?(path: string): { id: number; title: string } | null;
  now?(): number;
}

const out = (result: { stdout: Buffer }) => result.stdout.toString('utf8');

/** `owner/name` of a GitHub remote URL, or null. */
export function githubRepo(url: string): { owner: string; name: string } | null {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());

  return match === null ? null : { owner: match[1]!, name: match[2]! };
}

/** The `ghPath` of the GitHub source that reads `repo` (`owner/name`), else the default `gh` and its sign-in. */
export function githubGhPath(sources: Record<string, SourceSettings>, repo: string): string {
  // Read from the options as set, so a source whose other settings are incomplete still lends its gh.
  for (const source of Object.values(sources)) {
    const { repo: named, ghPath } = source.options;

    if (source.kind === 'github' && typeof named === 'string' && named.toLowerCase() === repo.toLowerCase() && typeof ghPath === 'string' && ghPath !== '') {
      return ghPath;
    }
  }

  return 'gh';
}

/** The pull request a work item's ticket links to (PRD R52): the newest a session reported, else the newest its text mentions. */
export function pullLinkOf(store: { workItem(id: number): { ticketId: number } | null; linksFor(ticketId: number): Link[] }, workItemId: number): { owner: string; name: string; number: number } | null {
  const ticketId = store.workItem(workItemId)?.ticketId;
  const pulls = (ticketId === undefined ? [] : store.linksFor(ticketId))
    .map((link) => ({ link, match: /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)$/.exec(link.target) }))
    .filter((one) => one.match !== null)
    .sort((a, b) => Number(a.link.mentioned) - Number(b.link.mentioned) || b.link.reportedAt - a.link.reportedAt);
  const match = pulls[0]?.match;

  return match == null ? null : { owner: match[1]!, name: match[2]!, number: Number(match[3]) };
}

interface ReflogEntry {
  sha: string;
  time: number;
  subject: string;
}

/** A ref's reflog, newest first; empty when it has none. */
async function reflog(git: Git, cwd: string, ref: string): Promise<ReflogEntry[]> {
  const read = await git(['log', '-g', '--no-color', '--date=unix', '--format=%H%x1f%gd%x1f%gs', ref, '--'], cwd);

  if (read.code !== 0) {
    return [];
  }

  return out(read)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [sha = '', selector = '', ...subject] = line.split('\x1f');

      return { sha, time: Number(/@\{(\d+)\}$/.exec(selector)?.[1] ?? NaN), subject: subject.join('\x1f') };
    });
}

/** What git knows about the repository, read once per stack read. */
interface Repo {
  root: string;
  head: string;
  branch: string | null;
  /** Local branches' tips and upstream tracking, by short name. */
  branches: Map<string, { sha: string; gone: boolean }>;
  /** Each worktree's path by its branch's short name, and every worktree's path. */
  worktreeOf: Map<string, string>;
  worktrees: string[];
  /** The remote default branch's ref (`origin/main`) and its short name (`main`). */
  baseRef: string | null;
  baseName: string | null;
  /** The merge base with the remote default branch, and the commits a range may start from (`readChanges`). */
  base: string | null;
  starts: Set<string>;
  fetchHead: string;
  /** Remote branches' tips, by `remote/name`. */
  remoteRefs: Map<string, string>;
  /** The main checkout's folder name, which names the repository. */
  repo: string;
  remotes: Map<string, string>;
}

async function readRepo(root: string, git: Git): Promise<Repo | { error: string }> {
  const [head, symbolic, refs, worktrees, paths, remotes] = await Promise.all([
    git(['rev-parse', '--verify', 'HEAD'], root),
    git(['symbolic-ref', '-q', '--short', 'HEAD'], root),
    git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:track)', 'refs/heads', 'refs/remotes'], root),
    git(['worktree', 'list', '--porcelain', '-z'], root),
    git(['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD', '--git-common-dir'], root),
    git(['config', '--get-regexp', '^remote\\..*\\.url$'], root),
  ]);
  const headSha = out(head).trim();

  if (head.code !== 0 || !SHA.test(headSha)) {
    return { error: 'The repository has no commit yet.' };
  }

  const branches = new Map<string, { sha: string; gone: boolean }>();
  const remoteRefs = new Map<string, string>();

  for (const line of out(refs).split('\n')) {
    const [name = '', sha = '', track = ''] = line.split('\0');

    if (name.startsWith('refs/heads/')) {
      branches.set(name.slice('refs/heads/'.length), { sha, gone: track === '[gone]' });
    } else if (name.startsWith('refs/remotes/')) {
      remoteRefs.set(name.slice('refs/remotes/'.length), sha);
    }
  }

  const worktreeOf = new Map<string, string>();
  const allWorktrees: string[] = [];
  let path: string | null = null;

  for (const field of out(worktrees).split('\0')) {
    if (field.startsWith('worktree ')) {
      path = field.slice('worktree '.length);
      allWorktrees.push(path);
    } else if (field.startsWith('branch refs/heads/') && path !== null) {
      worktreeOf.set(field.slice('branch refs/heads/'.length), path);
    }
  }

  // origin/HEAD names the default branch; else the first of the others that exists.
  const pointed = await git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], root);
  const baseRef = pointed.code === 0 && out(pointed).trim() !== '' ? out(pointed).trim() : (BASE_REFS.slice(1).find((ref) => remoteRefs.has(ref)) ?? null);
  const merged = baseRef === null ? null : await git(['merge-base', 'HEAD', baseRef], root);
  const base = merged !== null && merged.code === 0 && SHA.test(out(merged).trim()) ? out(merged).trim() : null;
  const listed = base === null ? null : await git(['rev-list', '--parents', `${base}..HEAD`, '--'], root);
  const starts = new Set<string>(base === null ? [] : [base]);

  for (const line of listed === null ? [] : out(listed).split('\n')) {
    line
      .split(' ')
      .filter((sha) => SHA.test(sha))
      .forEach((sha) => starts.add(sha));
  }

  const remoteUrls = new Map<string, string>();

  for (const line of out(remotes).split('\n')) {
    const match = /^remote\.(.+)\.url (.+)$/.exec(line.trim());

    if (match !== null) {
      remoteUrls.set(match[1]!, match[2]!);
    }
  }

  return {
    root,
    head: headSha,
    branch: symbolic.code === 0 && out(symbolic).trim() !== '' ? out(symbolic).trim() : null,
    branches,
    worktreeOf,
    worktrees: allWorktrees,
    baseRef,
    baseName: baseRef === null ? null : baseRef.slice(baseRef.indexOf('/') + 1),
    base,
    starts,
    fetchHead: out(paths).trim().split('\n')[0] ?? '',
    remoteRefs,
    repo: basename(dirname(out(paths).trim().split('\n')[1] ?? root)) || basename(root),
    remotes: remoteUrls,
  };
}

/**
 * What the stack's answer depends on in git: HEAD's name and commit, every local and remote branch with its upstream tracking, and the times
 * of the reflogs it reads (each worktree's HEAD and each local branch's) and of `FETCH_HEAD`, and the remotes' URLs, which decide the GitHub
 * repository: four git commands and a `stat` per reflog.
 */
async function stateKey(root: string, git: Git): Promise<string | null> {
  const [head, refs, dirs, remotes] = await Promise.all([
    git(['rev-parse', '--symbolic-full-name', 'HEAD', 'HEAD'], root),
    git(['for-each-ref', '--format=%(refname) %(objectname) %(upstream:track) %(symref)', 'refs/heads', 'refs/remotes'], root),
    git(['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-path', 'FETCH_HEAD'], root),
    git(['config', '--get-regexp', '^remote\\..*\\.url$'], root),
  ]);

  if (head.code !== 0 || refs.code !== 0 || dirs.code !== 0) {
    return null;
  }

  const [common = '', fetchHead = ''] = out(dirs).trim().split('\n');
  const time = async (path: string) => {
    try {
      return String((await stat(path, { bigint: true })).mtimeNs);
    } catch {
      return '-';
    }
  };
  const worktreeLogs = await (async () => {
    try {
      return (await readdir(join(common, 'worktrees'))).map((one) => join(common, 'worktrees', one, 'logs', 'HEAD'));
    } catch {
      return [];
    }
  })();
  const branches = out(refs)
    .split('\n')
    .map((line) => line.split(' ')[0] ?? '')
    .filter((name) => name.startsWith('refs/heads/'));
  const times = await Promise.all([fetchHead, join(common, 'logs', 'HEAD'), ...worktreeLogs, ...branches.map((name) => join(common, 'logs', ...name.split('/')))].map(time));

  return `${out(head)}\n${out(refs)}\n${out(remotes)}\n${times.join(' ')}`;
}

/** A link found in the local reflog, or why none was. */
type ReflogLink = { name: string } | { base: true } | { unknown: true } | { none: true };

/**
 * The branch `name` was created from, as its reflog records it (`branch: Created from <ref>`, or for `Created from HEAD` the worktree HEAD
 * reflog's `checkout: moving from <prev> to <name>` at that time), used only when unambiguous, that branch was not renamed into or recreated
 * since, and `name` was not rebased onto something else since. A parent renamed since is followed to its name now.
 */
async function reflogParent(repo: Repo, name: string, git: Git): Promise<ReflogLink> {
  const own = await reflog(git, repo.root, `refs/heads/${name}`);
  const created = own.at(-1);
  const from = created === undefined ? null : /^branch: Created from (.+)$/.exec(created.subject)?.[1];

  if (created === undefined || from == null) {
    return { none: true };
  }

  let parent: string | null;

  if (from === 'HEAD') {
    const moves = (await Promise.all(repo.worktrees.map((path) => reflog(git, path, 'HEAD'))))
      .flat()
      .filter((entry) => entry.time === created.time && entry.subject.endsWith(` to ${name}`))
      .map((entry) => /^checkout: moving from (.+) to .+$/.exec(entry.subject)?.[1])
      .filter((one): one is string => one !== undefined);

    if (new Set(moves).size !== 1) {
      return { unknown: true };
    }

    parent = moves[0]!;
  } else {
    parent = from.startsWith('refs/heads/') ? from.slice('refs/heads/'.length) : from;
  }

  if (parent === repo.baseRef || parent === repo.baseName || parent === `refs/remotes/${repo.baseRef}`) {
    return { base: true };
  }

  if (SHA.test(parent) || /^[0-9a-f]{7,}$/.test(parent)) {
    return { unknown: true };
  }

  // Renamed since: its reflog moved to the new name with a `Branch: renamed` entry.
  if (!repo.branches.has(parent)) {
    const renamed = await Promise.all(
      [...repo.branches.keys()].map(async (other) => ((await reflog(git, repo.root, `refs/heads/${other}`)).some((entry) => entry.time >= created.time && entry.subject === `Branch: renamed refs/heads/${parent} to refs/heads/${other}`) ? other : null)),
    );
    const found = renamed.filter((one): one is string => one !== null);

    if (found.length !== 1) {
      return found.length === 0 && repo.remotes.size > 0 && parent.includes('/') ? { base: true } : { unknown: true };
    }

    parent = found[0]!;
  } else {
    const theirs = await reflog(git, repo.root, `refs/heads/${parent}`);
    const recreated = (theirs.at(-1)?.time ?? 0) > created.time;
    const renamedInto = theirs.some((entry) => entry.time > created.time && entry.subject.endsWith(` to refs/heads/${parent}`) && entry.subject.startsWith('Branch: renamed'));

    if (recreated || renamedInto) {
      return { unknown: true };
    }
  }

  // Rebased elsewhere since: each later rebase must be onto a commit of the parent.
  for (const entry of own) {
    const onto = new RegExp(`^rebase \\(finish\\): refs/heads/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} onto ([0-9a-f]+)$`).exec(entry.subject)?.[1];

    if (onto !== undefined && (await git(['merge-base', '--is-ancestor', onto, `refs/heads/${parent}`], repo.root)).code !== 0) {
      return { unknown: true };
    }
  }

  return { name: parent };
}

/** One GitHub observation of the current branch, kept apart from the git cache. */
interface GithubSeen {
  read: PullStackRead;
  at: number;
}

/** Where the current branch's pull request is read: the work item's linked one, else by branch in the upstream or origin repository. */
interface Target {
  key: string;
  repo: string;
  run: (gh: Gh, signal: AbortSignal) => Promise<PullStackRead>;
}

/** The chain of links below the current branch, before it is measured. */
interface Planned {
  name: string;
  relation: 'below' | 'above';
  source: LinkSource;
  pull?: StackPull;
}

interface Built {
  view: Omit<StackView, 'github'>;
  chain: string[];
  /** Each link's worktree, whose work item is looked up at each answer. */
  worktreeOf: Map<string, string>;
}

type Answer = { view: StackView; worktreeOf: Map<string, string> };

export class PageStack {
  constructor(private readonly deps: PageStackDeps) {}

  /** The last answer per worktree, by its git state. */
  readonly #kept = new Map<string, { key: string; built: Built; githubAt: number | null; repo: Pick<Repo, 'remotes' | 'branch'> }>();
  /** GitHub observations by `owner/name head` or linked pull request. */
  readonly #github = new Map<string, GithubSeen>();
  /** The last failed GitHub read per target, kept apart so it never replaces an observation. */
  readonly #failed = new Map<string, GithubSeen>();
  /** GitHub reads still running, by the same key. */
  readonly #githubReads = new Map<string, Promise<GithubSeen>>();
  /** Stack reads running, by worktree and git state. */
  readonly #flights = new Map<string, Promise<Answer | { error: string }>>();

  get #git(): Git {
    return this.deps.git ?? nodeGit;
  }

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The current branch's GitHub target, or null when it has no GitHub remote. */
  #target(repo: Pick<Repo, 'remotes' | 'branch'>, workItemId: number | null): Target | null {
    const linked = workItemId === null ? null : (this.deps.pullLink?.(workItemId) ?? null);

    if (linked !== null) {
      return { key: `${linked.owner}/${linked.name}#${linked.number}`.toLowerCase(), repo: `${linked.owner}/${linked.name}`, run: (gh, signal) => readPullNumberStack(gh, linked, signal) };
    }

    const origin = githubRepo(repo.remotes.get('origin') ?? '');
    const upstream = githubRepo(repo.remotes.get('upstream') ?? '');
    const into = upstream ?? origin;

    if (into === null || repo.branch === null) {
      return null;
    }

    const headRepo = `${(origin ?? into).owner}/${(origin ?? into).name}`;
    const target = { owner: into.owner, name: into.name, head: repo.branch, headRepo };

    return { key: `${into.owner}/${into.name} ${headRepo} ${repo.branch}`.toLowerCase(), repo: `${into.owner}/${into.name}`, run: (gh, signal) => readPullStack(gh, target, signal) };
  }

  /**
   * GitHub's answer for a target: a kept observation under {@link GITHUB_KEPT_MS} unless `refresh`, else one read within
   * {@link GITHUB_DEADLINE_MS}. After a sign-in or rate-limit failure, none is read for {@link GITHUB_STOP_MS} unless `refresh`.
   */
  #readGithub(target: Target, refresh: boolean): Promise<GithubSeen> | GithubSeen | null {
    const kept = this.#github.get(target.key);
    const failed = this.#failed.get(target.key);

    if (!refresh && kept !== undefined && this.#now() - kept.at < GITHUB_KEPT_MS && (failed === undefined || failed.at < kept.at)) {
      return kept;
    }

    if (!refresh && failed !== undefined && failed.read.state === 'unavailable' && failed.read.stop && this.#now() - failed.at < GITHUB_STOP_MS) {
      return failed;
    }

    const running = this.#githubReads.get(target.key);

    if (running !== undefined) {
      return running;
    }

    const gh = this.deps.gh?.(target.repo) ?? null;

    if (gh === null) {
      const none: GithubSeen = { read: { state: 'unavailable', reason: 'No GitHub sign-in can read this repository.', stop: false }, at: this.#now() };

      this.#failed.set(target.key, none);
      return none;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_DEADLINE_MS);
    const read = target
      .run(gh, controller.signal)
      .catch((error: unknown): PullStackRead => ({ state: 'unavailable', reason: (error as Error).message, stop: false }))
      .then((answer): GithubSeen => {
        clearTimeout(timer);
        this.#githubReads.delete(target.key);

        const seen = { read: controller.signal.aborted && answer.state === 'unavailable' ? { ...answer, reason: `GitHub did not answer within ${GITHUB_DEADLINE_MS / 1000} seconds.` } : answer, at: this.#now() };

        // A failed read never replaces a successful observation, which is then used as stale.
        if (answer.state === 'unavailable') {
          this.#failed.set(target.key, seen);
        } else {
          this.#github.set(target.key, seen);
          this.#failed.delete(target.key);
        }

        return seen;
      });

    this.#githubReads.set(target.key, read);
    return read;
  }

  /**
   * `GET /v1/conversation/stack?window=<page key>[&refresh=1]`: the selected conversation's worktree's `StackView`. Answers from git within its own
   * time; when GitHub has not answered within {@link GITHUB_WAIT_MS}, `github.state` is `pending` and the page asks again.
   */
  async stack(key: string, refresh: unknown = null): Promise<ChangesReply> {
    const known = this.deps.isPage(key);
    const scope = known ? this.deps.scope(key) : null;

    if (scope === null) {
      return outOfScope(known, scope);
    }

    if (scope.cwd === null) {
      return { status: 409, body: { error: 'This conversation has no folder yet.' } };
    }

    const answer = await this.#read(scope, refresh === '1');
    const now = this.deps.scope(key);

    if (now === null || now.scopeGen !== scope.scopeGen || now.cwd !== scope.cwd || now.workItemId !== scope.workItemId) {
      return { status: 409, body: { error: "The window's conversation changed." } };
    }

    if ('error' in answer) {
      return { status: 409, body: answer };
    }

    // Work items are looked up at each answer, after the cache, so a newly linked one shows at once.
    const links = answer.view.links.map((link) => {
      const worktree = answer.worktreeOf.get(link.name);
      const workItem = worktree === undefined ? null : (this.deps.workItemAt?.(worktree) ?? null);

      return workItem === null ? link : { ...link, workItem };
    });
    const body = { scopeGen: scope.scopeGen, ...answer.view, links };

    return { status: 200, body, etag: etagOf(body) };
  }

  async #read(scope: WindowScope, refresh: boolean): Promise<Answer | { error: string }> {
    const root = scope.cwd!;
    const key = await stateKey(root, this.#git);
    const flightKey = `${root}\n${scope.workItemId ?? ''}\n${refresh ? 'refresh' : ''}\n${key ?? Math.random()}`;
    const flying = this.#flights.get(flightKey);

    if (flying !== undefined) {
      return flying;
    }

    const flight = this.#fly(scope, key, refresh).finally(() => this.#flights.delete(flightKey));

    this.#flights.set(flightKey, flight);
    return flight;
  }

  async #fly(scope: WindowScope, key: string | null, refresh: boolean): Promise<Answer | { error: string }> {
    const root = scope.cwd!;

    for (let attempt = 0; ; attempt++) {
      const kept = this.#kept.get(root);
      // While git's state is as kept, the kept answer is checked against GitHub alone, without reading the repository again.
      const hit = !refresh && kept !== undefined && key !== null && kept.key === key;
      const repo = hit ? null : await readRepo(root, this.#git);

      if (repo !== null && 'error' in repo) {
        return repo;
      }

      const target = this.#target(repo ?? kept!.repo, scope.workItemId);
      const github = target === null ? null : this.#readGithub(target, refresh);
      const settled = github instanceof Promise ? await Promise.race([github, new Promise<null>((resolve) => setTimeout(() => resolve(null), GITHUB_WAIT_MS))]) : github;
      const pending = github instanceof Promise && settled === null;
      // While GitHub is pending or unavailable, a successful observation is used, as stale; only without one does the chain fall to the reflog.
      const observed = target === null ? null : (this.#github.get(target.key) ?? null);
      const used = settled !== null && settled.read.state !== 'unavailable' ? settled : observed;
      const state = this.#githubState(target, settled, pending, used);

      if (hit && !pending && kept!.githubAt === (used?.at ?? null)) {
        return { view: { ...kept!.built.view, github: state }, worktreeOf: kept!.built.worktreeOf };
      }

      const read = repo ?? (await readRepo(root, this.#git));

      if ('error' in read) {
        return read;
      }

      const built = await this.#build(read, used?.read ?? null, target?.repo ?? null);
      const after = await stateKey(root, this.#git);

      // git moved during the read: read once more, so the answer is never older than the request.
      if (after !== key && attempt === 0) {
        key = after;
        continue;
      }

      if (after !== null && !pending) {
        this.#kept.set(root, { key: after, built, githubAt: used?.at ?? null, repo: { remotes: read.remotes, branch: read.branch } });
      }

      return { view: { ...built.view, github: state }, worktreeOf: built.worktreeOf };
    }
  }

  /** What the tree says about GitHub: none without a GitHub remote, pending, unavailable without an observation, stale with an older one. */
  #githubState(target: Target | null, settled: GithubSeen | null, pending: boolean, used: GithubSeen | null): StackView['github'] {
    if (target === null) {
      return { state: 'none', observedAt: null };
    }

    if (pending) {
      return { state: 'pending', observedAt: used?.at ?? null };
    }

    const failed = settled?.read.state === 'unavailable' ? settled.read : null;

    if (used === null) {
      return { state: 'unavailable', observedAt: null, reason: failed?.reason ?? 'GitHub could not be read.' };
    }

    return failed === null ? { state: 'fresh', observedAt: used.at } : { state: 'stale', observedAt: used.at, reason: failed.reason };
  }

  /** The links, from GitHub's stack or pull request base when GitHub found one, else from the reflog, measured against HEAD. */
  async #build(repo: Repo, github: PullStackRead | null, targetRepo: string | null): Promise<Built> {
    const git = this.#git;
    const planned: Planned[] = [];
    let incomplete = false;
    let stop = false;
    let pr: StackView['pr'];
    const seen = new Set<string>(repo.branch === null ? [] : [repo.branch]);
    const isBase = (name: string) => name === repo.baseName || name === repo.baseRef;

    if (github?.state === 'found' && github.stack !== null) {
      const stack: PullStack = github.stack;
      const at = stack.members.findIndex((member) => member.number === github.pr.number);

      for (let index = at - 1; index >= 0; index--) {
        planned.push({ name: stack.members[index]!.head, relation: 'below', source: 'github-stack', pull: stack.members[index]! });
        seen.add(stack.members[index]!.head);
      }

      if (!isBase(stack.trunk) && !seen.has(stack.trunk)) {
        planned.push({ name: stack.trunk, relation: 'below', source: 'github-stack' });
      }

      for (const member of stack.members.slice(at + 1)) {
        planned.push({ name: member.head, relation: 'above', source: 'github-stack', pull: member });
      }

      incomplete ||= !stack.complete;
      stop = true;
    } else if (github?.state === 'found') {
      if (!isBase(github.pr.base)) {
        planned.push({ name: github.pr.base, relation: 'below', source: 'pr-base' });
        seen.add(github.pr.base);
      } else {
        stop = true;
      }
    } else if (github?.state === 'absent' && github.closed !== undefined) {
      pr = { number: github.closed.number, state: github.closed.state, url: github.closed.url };
    }

    if (github?.state === 'absent' && github.several === true) {
      incomplete = true;
      stop = true;
    }

    // Below the last link GitHub gave, or the current branch: the reflog, as historical evidence only.
    let from = planned.filter((one) => one.relation === 'below').at(-1)?.name ?? repo.branch;

    while (!stop && from !== null && repo.branches.has(from) && planned.filter((one) => one.relation === 'below').length < MAX_LINKS) {
      const found = await reflogParent(repo, from, git);

      if ('none' in found || 'base' in found) {
        break;
      }

      if ('unknown' in found) {
        incomplete = true;
        break;
      }

      if (isBase(found.name)) {
        break;
      }

      if (seen.has(found.name)) {
        incomplete = true;
        break;
      }

      planned.push({ name: found.name, relation: 'below', source: 'reflog' });
      seen.add(found.name);
      from = found.name;
    }

    if (planned.filter((one) => one.relation === 'below').length >= MAX_LINKS) {
      incomplete = true;
    }

    // A base this clone has only as a remote branch is read from the remote of the repository the pull request targets first.
    const remotes = [...repo.remotes].filter(([, url]) => {
      const named = githubRepo(url);

      return named !== null && targetRepo !== null && `${named.owner}/${named.name}`.toLowerCase() === targetRepo.toLowerCase();
    }).map(([name]) => name);
    const order = [...new Set([...remotes, 'origin', 'upstream'])];
    const links = await Promise.all(planned.map((one) => this.#measure(repo, one, order)));
    const below = links.filter((link) => link.relation === 'below');

    incomplete ||= below.some((link) => link.forkPoint === null && !link.branchDeleted && link.pr?.state !== 'merged');

    // Each link's commits run from the next lower link's fork point (or the merge base) to its own.
    const lower = (index: number) => below.slice(index + 1).find((link) => link.forkPoint !== null)?.forkPoint ?? repo.base;

    for (const [index, link] of below.entries()) {
      if (link.forkPoint === null) {
        continue;
      }

      const ids = await this.#ids(repo, lower(index), link.forkPoint);

      link.commitIds = ids.ids;
      link.more = ids.more;
      link.actions.expand = ids.ids.length > 0;
    }

    const own = await this.#ids(repo, below.find((link) => link.forkPoint !== null)?.forkPoint ?? repo.base, 'HEAD');
    const listed = [...own.ids, ...below.flatMap((link) => link.commitIds)];
    // Each record starts with a record separator: the commit's fields, then the paths it changes, NUL-separated.
    const logged = listed.length === 0 ? null : await git(['log', '-z', '--no-walk=unsorted', '--no-color', '--no-show-signature', '--no-renames', '--diff-merges=first-parent', '--name-only', '--format=%x1e%H%x1f%P%x1f%at%x1f%ct%x1f%s', ...listed, '--'], repo.root);
    const infos =
      logged === null || logged.code !== 0
        ? []
        : out(logged)
            .split('\x1e')
            .filter((record) => record.trim() !== '')
            .map((record) => {
              const [head = '', ...paths] = record.split('\0');
              const [sha = '', parents = '', authored = '0', committed = '0', ...subject] = head.split('\x1f');
              const files = paths.map((path) => path.replace(/^\n/, '')).filter((path) => path !== '');

              return { sha, parent: parents.split(' ')[0] || null, subject: subject.join('\x1f'), authored: Number(authored), committed: Number(committed), time: Number(committed), files: files.slice(0, MAX_INFO_FILES) };
            });
    const [behindMain, fetched] = await Promise.all([
      repo.baseRef === null ? null : git(['rev-list', '--count', `HEAD..${repo.baseRef}`, '--'], repo.root),
      stat(repo.fetchHead).catch(() => null),
    ]);

    return {
      chain: planned.map((one) => one.name),
      worktreeOf: repo.worktreeOf,
      view: {
        repo: repo.repo,
        root: repo.root,
        branch: repo.branch,
        head: repo.head,
        commitIds: own.ids,
        infos,
        more: own.more,
        incomplete,
        ...(pr === undefined ? {} : { pr }),
        links,
        main: { ref: repo.baseRef, behind: behindMain !== null && behindMain.code === 0 ? Number(out(behindMain).trim()) : null, fetchedAt: fetched === null ? null : Math.floor(fetched.mtimeMs) },
      },
    };
  }

  /** The commits from `from` (exclusive) to `to`, newest first, at most {@link MAX_LINK_COMMITS}; all since the root without `from`. */
  async #ids(repo: Repo, from: string | null, to: string): Promise<{ ids: string[]; more: boolean }> {
    const read = await this.#git(['rev-list', `--max-count=${MAX_LINK_COMMITS + 1}`, from === null ? to : `${from}..${to}`, '--'], repo.root);
    const ids = read.code === 0 ? out(read).split('\n').filter((sha) => SHA.test(sha)) : [];

    return { ids: ids.slice(0, MAX_LINK_COMMITS), more: ids.length > MAX_LINK_COMMITS };
  }

  async #measure(repo: Repo, one: Planned, remotes: readonly string[]): Promise<StackLink> {
    const git = this.#git;
    const local = repo.branches.get(one.name);
    let tip: string | null = null;
    let tipSource: StackLink['tipSource'] = null;
    let localDiffers = false;

    if (one.pull !== undefined) {
      // GitHub's commit when this clone has it; else a same-named local branch only at that commit.
      if ((await git(['cat-file', '-e', `${one.pull.headSha}^{commit}`], repo.root)).code === 0) {
        tip = one.pull.headSha;
        tipSource = 'github';
      } else if (local?.sha === one.pull.headSha) {
        tip = local.sha;
        tipSource = 'local';
      }

      localDiffers = local !== undefined && local.sha !== one.pull.headSha;
    } else if (local !== undefined) {
      tip = local.sha;
      tipSource = 'local';
    } else {
      // A pull request's base this clone has only as a remote branch, as in a clone that never checked it out.
      for (const remote of remotes) {
        const sha = repo.remoteRefs.get(`${remote}/${one.name}`);

        if (sha !== undefined) {
          tip = sha;
          tipSource = 'local';
          break;
        }
      }
    }

    const base: StackLink = {
      name: one.name,
      relation: one.relation,
      source: one.source,
      ...(one.pull === undefined ? {} : { pr: { number: one.pull.number, state: one.pull.state, url: one.pull.url } }),
      tip,
      tipSource,
      forkPoint: null,
      behind: null,
      upstreamMissing: local?.gone === true,
      // Only GitHub can say a branch was deleted; a base this clone lacks is only not in it.
      branchDeleted: one.pull?.branchDeleted ?? false,
      notInClone: tip === null,
      localDiffers,
      commitIds: [],
      more: false,
      actions: { expand: false, diffSince: false },
    };

    if (tip === null) {
      return one.relation === 'above' ? { ...base, lacks: null } : base;
    }

    if (one.relation === 'above') {
      const lacks = await git(['rev-list', '--count', `${tip}..HEAD`, '--'], repo.root);

      return { ...base, lacks: lacks.code === 0 ? Number(out(lacks).trim()) : null };
    }

    const [merged, behind] = await Promise.all([git(['merge-base', tip, 'HEAD'], repo.root), git(['rev-list', '--count', `HEAD..${tip}`, '--'], repo.root)]);
    const fork = out(merged).trim();
    // Only a commit the range routes accept as a start, so diff since never widens what they read.
    const forkPoint = merged.code === 0 && repo.starts.has(fork) ? fork : null;

    return { ...base, forkPoint, behind: behind.code === 0 ? Number(out(behind).trim()) : null, actions: { expand: false, diffSince: forkPoint !== null } };
  }
}
