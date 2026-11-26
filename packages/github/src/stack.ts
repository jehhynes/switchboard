import type { Gh } from './gh.js';

/**
 * Reads a branch's pull request and the native GitHub stack it belongs to, for the Changes tab's stacked bases (PRD R128, mechanics M163).
 * Read-only: one GraphQL query per read.
 */

export type PullState = 'open' | 'merged' | 'closed' | 'queued';

export interface StackPull {
  number: number;
  state: PullState;
  url: string;
  /** The head branch's name and its commit on GitHub. */
  head: string;
  headSha: string;
  base: string;
  /** `owner/name` of the head branch's repository, null when GitHub no longer has it. */
  headRepo: string | null;
  /** GitHub no longer has the head branch (its `headRef` is null). */
  branchDeleted: boolean;
}

export interface PullStack {
  number: number;
  /** The branch the stack's lowest member merges into. */
  trunk: string;
  /** Members lowest first, by GitHub's position. */
  members: (StackPull & { position: number })[];
  /** False when GitHub has more members than one page holds. */
  complete: boolean;
}

export type PullStackRead =
  /** The branch's open pull request, with its stack or null when it is in none. */
  | { state: 'found'; pr: StackPull; stack: PullStack | null }
  /** The branch has no open pull request; `closed` names its newest merged or closed one, `several` when more than one open one matches or GitHub has more than one page of them. */
  | { state: 'absent'; closed?: StackPull; several?: true }
  /** GitHub could not be read; `stop` when signing in or the rate limit failed, so no other read is tried this time. */
  | { state: 'unavailable'; reason: string; stop: boolean };

const PULL_FIELDS = 'number state url isInMergeQueue headRefName headRefOid baseRefName headRef { name } headRepository { nameWithOwner }';
const STACK_FIELDS = `stack { number baseRefName entries(first: 50) { pageInfo { hasNextPage } nodes { position pullRequest { ${PULL_FIELDS} } } } }`;

export const PULL_STACK_QUERY = `query($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    open: pullRequests(headRefName: $head, first: 20, states: [OPEN]) {
      totalCount
      nodes { ${PULL_FIELDS} ${STACK_FIELDS} }
    }
    done: pullRequests(headRefName: $head, first: 20, states: [MERGED, CLOSED], orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { ${PULL_FIELDS} }
    }
  }
}`;

export const PULL_NUMBER_STACK_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${PULL_FIELDS} ${STACK_FIELDS} }
  }
}`;

interface RawPull {
  number?: unknown;
  state?: unknown;
  url?: unknown;
  isInMergeQueue?: unknown;
  headRefName?: unknown;
  headRefOid?: unknown;
  baseRefName?: unknown;
  headRef?: { name?: unknown } | null;
  headRepository?: { nameWithOwner?: unknown } | null;
  stack?: { number?: unknown; baseRefName?: unknown; entries?: { pageInfo?: { hasNextPage?: unknown }; nodes?: { position?: unknown; pullRequest?: RawPull | null }[] } } | null;
}

function pullOf(raw: RawPull | null | undefined): StackPull | null {
  if (raw == null || typeof raw.number !== 'number' || typeof raw.headRefName !== 'string' || typeof raw.baseRefName !== 'string' || typeof raw.headRefOid !== 'string') {
    return null;
  }

  const state: PullState = raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : raw.isInMergeQueue === true ? 'queued' : 'open';

  return {
    number: raw.number,
    state,
    url: typeof raw.url === 'string' ? raw.url : '',
    head: raw.headRefName,
    headSha: raw.headRefOid,
    base: raw.baseRefName,
    headRepo: typeof raw.headRepository?.nameWithOwner === 'string' ? raw.headRepository.nameWithOwner : null,
    branchDeleted: raw.headRef === null,
  };
}

function stackOf(raw: RawPull['stack']): PullStack | null {
  if (raw == null || typeof raw.number !== 'number' || typeof raw.baseRefName !== 'string') {
    return null;
  }

  const members = (raw.entries?.nodes ?? [])
    .map((node) => {
      const pull = pullOf(node.pullRequest);

      return pull === null || typeof node.position !== 'number' ? null : { ...pull, position: node.position };
    })
    .filter((one): one is StackPull & { position: number } => one !== null)
    .sort((a, b) => a.position - b.position);

  return { number: raw.number, trunk: raw.baseRefName, members, complete: raw.entries?.pageInfo?.hasNextPage !== true };
}

/** Why gh failed, and whether to stop reading GitHub for this read: signing in or the rate limit. */
function unavailable(error: string): PullStackRead {
  return { state: 'unavailable', reason: error, stop: /not signed in|rate limit|submitted too quickly|HTTP 403/i.test(error) };
}

/** GraphQL's answer as data, or why it is not one. */
function dataOf(json: unknown): { repository: Record<string, unknown> | null } | string {
  const body = json as { data?: { repository?: Record<string, unknown> | null }; errors?: { message?: string; type?: string }[] } | null;

  if (body?.data == null || (body.data.repository == null && body.errors?.[0]?.message !== undefined)) {
    return body?.errors?.[0]?.message ?? 'GitHub returned no data.';
  }

  return { repository: body.data.repository ?? null };
}

/**
 * The open pull request of `head` (a branch of `headRepo`, `owner/name`) in `owner/name`, with its stack. A pull request from another repository
 * with the same branch name is not this branch's.
 */
export async function readPullStack(gh: Gh, target: { owner: string; name: string; head: string; headRepo: string }, signal?: AbortSignal): Promise<PullStackRead> {
  const answer = await gh(PULL_STACK_QUERY, { owner: target.owner, name: target.name, head: target.head }, signal);

  if ('error' in answer) {
    return unavailable(answer.error);
  }

  const data = dataOf(answer.json);

  if (typeof data === 'string') {
    return unavailable(data);
  }

  if (data.repository === null) {
    return unavailable(`GitHub has no repository ${target.owner}/${target.name} this sign-in can read.`);
  }

  const ours = (raw: RawPull) => typeof raw.headRepository?.nameWithOwner === 'string' && raw.headRepository.nameWithOwner.toLowerCase() === target.headRepo.toLowerCase();
  const listed = data.repository['open'] as { totalCount?: unknown; nodes?: RawPull[] } | undefined;
  const open = (listed?.nodes ?? []).filter(ours);
  const done = ((data.repository['done'] as { nodes?: RawPull[] } | undefined)?.nodes ?? []).filter(ours);

  // Open pull requests past the first page could be this branch's too.
  if (open.length > 1 || (typeof listed?.totalCount === 'number' && listed.totalCount > (listed.nodes ?? []).length)) {
    return { state: 'absent', several: true };
  }

  if (open.length === 1) {
    const pr = pullOf(open[0]);

    return pr === null ? unavailable('GitHub returned a pull request without its branches.') : { state: 'found', pr, stack: stackOf(open[0]!.stack) };
  }

  const closed = pullOf(done[0]);

  return closed === null ? { state: 'absent' } : { state: 'absent', closed };
}

/** Pull request `number` of `owner/name`, as a work item's verified link names it, with its stack; absent unless it is open. */
export async function readPullNumberStack(gh: Gh, target: { owner: string; name: string; number: number }, signal?: AbortSignal): Promise<PullStackRead> {
  const answer = await gh(PULL_NUMBER_STACK_QUERY, { owner: target.owner, name: target.name, number: target.number }, signal);

  if ('error' in answer) {
    return unavailable(answer.error);
  }

  const data = dataOf(answer.json);

  if (typeof data === 'string') {
    return unavailable(data);
  }

  const raw = data.repository?.['pullRequest'] as RawPull | null | undefined;
  const pr = pullOf(raw);

  if (pr === null) {
    return { state: 'absent' };
  }

  return pr.state === 'open' || pr.state === 'queued' ? { state: 'found', pr, stack: stackOf(raw!.stack) } : { state: 'absent', closed: pr };
}
