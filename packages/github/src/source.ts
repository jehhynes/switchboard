import type { ContextResult, PolledTicket, PollResult, Source, Ticket } from '@switchboard/core';
import { clip } from '@switchboard/core';
import type { GithubConfig } from './config.js';
import type { Gh } from './gh.js';
import { CONTEXT_QUERY, ISSUES_QUERY } from './queries.js';

/** Each issue body, comment and review-thread comment is clipped to this many characters (GC). */
export const TEXT_LIMIT = 2_000;

const UNEXPECTED = 'GitHub returned an unexpected response.';

interface Actor {
  login: string;
}

interface ProjectRef {
  number: number;
  owner: { login?: string } | null;
}

interface IssueNode {
  number: number;
  title: string;
  url: string;
  projectItems: { nodes: { project: ProjectRef; fieldValueByName: { name?: string; updatedAt?: string } | null }[] };
  assignees?: { nodes: { login: string }[] };
  timelineItems?: { nodes: { __typename?: string; createdAt?: string; assignee?: { login?: string } | null }[] };
}

interface SearchPage {
  data: { search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (IssueNode | Record<string, never>)[] } };
}

interface Comment {
  body: string;
  createdAt: string;
  author: Actor | null;
}

interface TimelineNode {
  __typename: string;
  createdAt?: string;
  actor?: Actor | null;
  assignee?: { login?: string } | null;
  previousStatus?: string | null;
  status?: string | null;
  project?: ProjectRef | null;
}

interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  updatedAt: string;
  body: string;
  author: Actor | null;
  reviewRequests: { nodes: { requestedReviewer: { login?: string; slug?: string } | null }[] };
  comments: { nodes: Comment[] };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
  reviews: { nodes: { state: string; submittedAt: string | null; author: Actor | null }[] };
  reviewThreads: { nodes: { isResolved: boolean; comments: { nodes: Comment[] } }[] };
}

interface ContextIssue {
  number: number;
  title: string;
  url: string;
  body: string;
  assignees: { nodes: Actor[] };
  comments: { nodes: Comment[] };
  timelineItems: { nodes: TimelineNode[] };
  closedByPullRequestsReferences: { nodes: PullRequest[] };
}

export class GithubSource implements Source {
  readonly name = 'github';

  constructor(
    private readonly config: GithubConfig,
    private readonly gh: Gh,
  ) {}

  /** Reads every open issue assigned to a configured login on the project. An issue whose status is not configured is listed as not assigned. A malformed response is a failed read. */
  async poll(): Promise<PollResult> {
    try {
      return await this.readIssues();
    } catch {
      return { error: UNEXPECTED };
    }
  }

  async context(ticket: Ticket): Promise<ContextResult> {
    try {
      return await this.readContext(ticket);
    } catch {
      return { error: UNEXPECTED };
    }
  }

  keyOfBranch(branch: string): string | null {
    return this.config.branchPattern.exec(branch)?.[1] ?? null;
  }

  /**
   * When the issue last came to the operator: the later of their latest assignment and the last Status change. The Status
   * field's updatedAt is read because status-change events have been missing from the issue timeline since about 2026-09-25.
   */
  private waitingSince(timeline: IssueNode['timelineItems'], statusUpdatedAt: string | undefined): number | null {
    const assigned = (timeline?.nodes ?? []).filter((event) => event.__typename !== 'UnassignedEvent' && event.assignee?.login !== undefined && this.config.logins.includes(event.assignee.login));
    const times = [statusUpdatedAt, assigned.at(-1)?.createdAt].map((time) => (time === undefined ? NaN : Date.parse(time))).filter((time) => !Number.isNaN(time));

    return times.length === 0 ? null : Math.max(...times);
  }

  /**
   * When the operator's current assignment began (GC `assignedSince`): undo the events newest first until none of their logins is
   * assigned. Null when none is assigned or the events start mid-assignment. A status change does not count (PRD R27).
   */
  private assignedSince(node: IssueNode): number | null {
    const own = new Set(this.config.logins.map((login) => login.toLowerCase()));
    const held = new Set((node.assignees?.nodes ?? []).map((actor) => actor.login.toLowerCase()).filter((login) => own.has(login)));

    if (held.size === 0) {
      return null;
    }

    // The timeline is in event order, which also orders events within one second.
    for (const event of [...(node.timelineItems?.nodes ?? [])].reverse()) {
      const login = event.assignee?.login?.toLowerCase();

      if (login === undefined || !own.has(login)) {
        continue;
      }

      if (event.__typename === 'AssignedEvent') {
        held.delete(login);

        if (held.size === 0) {
          const at = Date.parse(event.createdAt ?? '');

          return Number.isNaN(at) ? null : at;
        }
      } else if (event.__typename === 'UnassignedEvent') {
        held.add(login);
      }
    }

    return null;
  }

  private async readIssues(): Promise<PollResult> {
    const { repo, logins, project, assignedStatuses, maxPages } = this.config;
    const q = [`repo:${repo}`, 'is:issue', 'is:open', ...logins.map((login) => `assignee:${login}`), `project:${project.owner}/${project.number}`].join(' ');
    const tickets: PolledTicket[] = [];
    let after: string | null = null;

    for (let page = 1; page <= maxPages; page++) {
      const result = await this.gh(ISSUES_QUERY, { q, status: project.statusField, ...(after === null ? {} : { after }) });

      if ('error' in result) {
        return result;
      }

      const search = (result.json as SearchPage).data.search;

      for (const node of search.nodes) {
        if (!('number' in node)) {
          continue;
        }

        const field = node.projectItems.nodes.find((item) => this.onProject(item.project))?.fieldValueByName;
        const status = field?.name;

        tickets.push({
          sourceKey: String(node.number),
          ref: `#${node.number}`,
          sourceId: null,
          title: node.title,
          url: node.url,
          assigned: status !== undefined && assignedStatuses.includes(status),
          pool: false,
          sortAt: this.waitingSince(node.timelineItems, field?.updatedAt),
          enteredAt: this.assignedSince(node as IssueNode),
        });
      }

      if (!search.pageInfo.hasNextPage) {
        return { tickets };
      }

      after = search.pageInfo.endCursor;
    }

    return { error: `More than ${maxPages} pages of assigned issues; raise sources.github.maxPages.` };
  }

  private async readContext(ticket: Ticket): Promise<ContextResult> {
    const [owner = '', name = ''] = this.config.repo.split('/');
    const result = await this.gh(CONTEXT_QUERY, { owner, name, number: Number(ticket.sourceKey) });

    if ('error' in result) {
      return result;
    }

    const issue = (result.json as { data?: { repository?: { issue?: ContextIssue | null } } } | null)?.data?.repository?.issue;

    if (issue === undefined || issue === null) {
      return { error: `Issue ${ticket.sourceKey} was not found in ${this.config.repo}.` };
    }

    return { context: this.format(issue) };
  }

  private onProject(project: ProjectRef | null | undefined): boolean {
    return project?.number === this.config.project.number && project.owner?.login === this.config.project.owner;
  }

  private format(issue: ContextIssue): string {
    const status = issue.timelineItems.nodes.filter((event) => event.__typename === 'ProjectV2ItemStatusChangedEvent' && event.status && this.onProject(event.project)).at(-1)?.status;
    const lines = [
      `GitHub issue #${issue.number}: ${issue.title}`,
      issue.url,
      `Board status: ${status ?? 'unknown'}`,
      `Assignees: ${issue.assignees.nodes.map((assignee) => assignee.login).join(', ') || 'none'}`,
      '',
      '## Issue body',
      clip(issue.body, TEXT_LIMIT) || '(empty)',
    ];
    const history = issue.timelineItems.nodes.map((event) => this.historyLine(event)).filter((line) => line !== null);

    if (history.length > 0) {
      lines.push('', '## Status and assignment history', ...history);
    }

    if (issue.comments.nodes.length > 0) {
      lines.push('', `## Last ${issue.comments.nodes.length} comments`);

      for (const comment of issue.comments.nodes) {
        lines.push('', commentHeading(comment), clip(comment.body, TEXT_LIMIT));
      }
    }

    const pr = pullRequestOf(issue.closedByPullRequestsReferences.nodes);

    if (pr !== null) {
      lines.push('', ...pullRequestLines(pr));
    }

    return lines.join('\n');
  }

  private historyLine(event: TimelineNode): string | null {
    const who = event.actor?.login ?? 'someone';
    const at = event.createdAt?.slice(0, 16).replace('T', ' ') ?? '';

    if (event.__typename === 'ProjectV2ItemStatusChangedEvent' && event.status && this.onProject(event.project)) {
      return `${at} ${who}: status ${event.previousStatus || '(none)'} → ${event.status}`;
    }

    if (event.__typename === 'AssignedEvent' && event.assignee?.login) {
      return `${at} ${who}: assigned ${event.assignee.login}`;
    }

    if (event.__typename === 'UnassignedEvent' && event.assignee?.login) {
      return `${at} ${who}: unassigned ${event.assignee.login}`;
    }

    return null;
  }
}

function commentHeading(comment: Comment): string {
  return `### ${comment.author?.login ?? 'ghost'}, ${comment.createdAt.slice(0, 16).replace('T', ' ')}`;
}

/** The most recently updated open closing pull request, else the most recently updated one (GC selectPullRequest). */
function pullRequestOf(nodes: PullRequest[]): PullRequest | null {
  const byRecency = [...nodes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return byRecency.find((pr) => pr.state === 'OPEN') ?? byRecency[0] ?? null;
}

function pullRequestLines(pr: PullRequest): string[] {
  const checks = pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? 'none';
  const lines = [
    `## Pull request #${pr.number}: ${pr.title}`,
    pr.url,
    `Author: ${pr.author?.login ?? 'ghost'}. State: ${pr.state}${pr.isDraft ? ' (draft)' : ''}. Checks: ${checks}.`,
    '',
    clip(pr.body, TEXT_LIMIT) || '(empty)',
  ];

  const requested = pr.reviewRequests.nodes.map((request) => request.requestedReviewer?.login ?? request.requestedReviewer?.slug).filter((name) => name !== undefined);

  if (requested.length > 0) {
    lines.push(`Review requested from: ${requested.join(', ')}`);
  }

  if (pr.comments.nodes.length > 0) {
    lines.push('', `### Last ${pr.comments.nodes.length} pull request comments`);

    for (const comment of pr.comments.nodes) {
      lines.push(commentHeading(comment), clip(comment.body, TEXT_LIMIT));
    }
  }

  if (pr.reviews.nodes.length > 0) {
    lines.push('', '### Reviews', ...pr.reviews.nodes.map((review) => `${review.submittedAt?.slice(0, 16).replace('T', ' ') ?? ''} ${review.author?.login ?? 'ghost'}: ${review.state}`));
  }

  if (pr.reviewThreads.nodes.length > 0) {
    lines.push('', `### Last ${pr.reviewThreads.nodes.length} review threads`);

    for (const thread of pr.reviewThreads.nodes) {
      lines.push('', `#### ${thread.isResolved ? 'Resolved' : 'Unresolved'} thread`);

      for (const comment of thread.comments.nodes) {
        lines.push(commentHeading(comment), clip(comment.body, TEXT_LIMIT));
      }
    }
  }

  return lines;
}
