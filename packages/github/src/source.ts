import type { ContextResult, PolledTicket, PollResult, Source, Ticket } from '@switchboard/core';
import { clip } from '@switchboard/core';
import type { GithubConfig } from './config.js';
import type { Gh } from './gh.js';
import { CONTEXT_QUERY, FIELD_QUERY, ISSUES_QUERY } from './queries.js';

/** Each issue body, comment and review-thread comment is clipped to this many characters (GC). */
export const TEXT_LIMIT = 2_000;

const UNEXPECTED = 'GitHub returned an unexpected response.';

/** A Status field change this long after the last status event has no timeline event of its own. */
const UNLOGGED_STATUS_MS = 60_000;

interface Actor {
  login: string;
}

interface ProjectRef {
  number: number;
  owner: { login?: string } | null;
}

interface ProjectItems {
  nodes: { project: ProjectRef; fieldValueByName: { name?: string; updatedAt?: string } | null }[];
}

interface IssueNode {
  number: number;
  title: string;
  url: string;
  projectItems: ProjectItems;
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
  projectItems: ProjectItems;
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
    // A field that cannot hold a status would read every issue as unassigned and end its work item.
    const problem = await this.fieldProblem();

    if (problem !== null) {
      return { error: problem };
    }

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
    const result = await this.gh(CONTEXT_QUERY, { owner, name, number: Number(ticket.sourceKey), status: this.config.project.statusField });

    if ('error' in result) {
      return result;
    }

    const issue = (result.json as { data?: { repository?: { issue?: ContextIssue | null } } } | null)?.data?.repository?.issue;

    if (issue === undefined || issue === null) {
      return { error: `Issue ${ticket.sourceKey} was not found in ${this.config.repo}.` };
    }

    const pr = pullRequestOf(issue.closedByPullRequestsReferences.nodes);

    return { context: this.format(issue, pr), links: pr === null ? [] : [{ label: `Pull request #${pr.number}`, target: pr.url }] };
  }

  /** Why the configured project's status field cannot hold a status, or null when it is a single-select field. */
  private async fieldProblem(): Promise<string | null> {
    const { owner, number, statusField } = this.config.project;
    const missing = `Project ${owner}/${number} has no field named "${statusField}". Set sources.github.project.statusField.`;
    const result = await this.gh(FIELD_QUERY, { owner, number, status: statusField });

    if ('error' in result) {
      const lines = result.error.split('\n').filter((line) => line.trim() !== '');

      // Rewrite gh's message only when it is the sole error, so another error stays visible.
      return lines.length > 0 && lines.every((line) => /ProjectV2FieldConfiguration with the name/.test(line)) ? missing : result.error;
    }

    const json = result.json as { data?: { repositoryOwner?: { projectV2?: { field?: { __typename?: string } | null } | null } | null } } | null;
    const field = json?.data?.repositoryOwner?.projectV2?.field;

    if (field === null) {
      return missing;
    }

    if (typeof field?.__typename !== 'string') {
      return UNEXPECTED;
    }

    return field.__typename === 'ProjectV2SingleSelectField' ? null : `The "${statusField}" field on project ${owner}/${number} is a ${field.__typename}, not a single-select field.`;
  }

  private onProject(project: ProjectRef | null | undefined): boolean {
    return project?.number === this.config.project.number && project.owner?.login === this.config.project.owner;
  }

  private format(issue: ContextIssue, pr: PullRequest | null): string {
    // GitHub stopped logging status events around 2026-09-25, so the Status field is the current status.
    const field = issue.projectItems.nodes.find((item) => this.onProject(item.project))?.fieldValueByName;
    const lines = [
      `GitHub issue #${issue.number}: ${issue.title}`,
      issue.url,
      `Board status: ${field?.name ?? 'unknown'}`,
      `Assignees: ${issue.assignees.nodes.map((assignee) => assignee.login).join(', ') || 'none'}`,
      '',
      '## Issue body',
      clip(issue.body, TEXT_LIMIT) || '(empty)',
    ];
    const history = this.history(issue.timelineItems.nodes, field?.name, field?.updatedAt);

    if (history.length > 0) {
      lines.push('', '## Status and assignment history', ...history);
    }

    if (issue.comments.nodes.length > 0) {
      lines.push('', `## Last ${issue.comments.nodes.length} comments`);

      for (const comment of issue.comments.nodes) {
        lines.push('', commentHeading(comment), clip(comment.body, TEXT_LIMIT));
      }
    }

    if (pr !== null) {
      lines.push('', ...pullRequestLines(pr));
    }

    return lines.join('\n');
  }

  /** Adds the Status field's last change when the timeline has no event for it. */
  private history(events: TimelineNode[], status: string | undefined, updatedAt: string | undefined): string[] {
    const lines = events.map((event) => ({ at: event.createdAt ?? '', line: this.historyLine(event) }));
    const lastEvent = events.filter((event) => this.isStatusEvent(event)).at(-1)?.createdAt;

    if (status !== undefined && updatedAt !== undefined && (lastEvent === undefined || Date.parse(updatedAt) - Date.parse(lastEvent) > UNLOGGED_STATUS_MS)) {
      const index = lines.findIndex((entry) => entry.at > updatedAt);
      const line = `${updatedAt.slice(0, 16).replace('T', ' ')} someone: status → ${status} (no timeline event)`;

      lines.splice(index === -1 ? lines.length : index, 0, { at: updatedAt, line });
    }

    return lines.map((entry) => entry.line).filter((line) => line !== null);
  }

  private isStatusEvent(event: TimelineNode): boolean {
    return event.__typename === 'ProjectV2ItemStatusChangedEvent' && !!event.status && this.onProject(event.project);
  }

  private historyLine(event: TimelineNode): string | null {
    const who = event.actor?.login ?? 'someone';
    const at = event.createdAt?.slice(0, 16).replace('T', ' ') ?? '';

    if (this.isStatusEvent(event)) {
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
