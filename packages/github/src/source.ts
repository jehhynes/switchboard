import type { Anchor, ContextResult, LinkCheck, PolledTicket, PollResult, Source, Ticket, TicketLookup } from '@switchboard/core';
import { clip } from '@switchboard/core';
import type { GithubConfig } from './config.js';
import type { Gh } from './gh.js';
import { CONTEXT_QUERY, FIELD_QUERY, ISSUE_QUERY, ISSUES_QUERY, PULL_REQUEST_QUERY } from './queries.js';
import type { Roles, RolesResult } from './roles.js';
import { NO_ISSUE, readAssigned, readAssignment } from './assignment.js';

/** Each issue body, comment and review-thread comment is clipped to this many characters (GC). */
export const TEXT_LIMIT = 2_000;

const UNEXPECTED = 'GitHub returned an unexpected response.';

/** A Status field change this long after the last status event has no timeline event of its own. */
const UNLOGGED_STATUS_MS = 60_000;

const PULL_REQUEST_PATH = /^\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:\/|$)/;
const ISSUE_PATH = /^\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)(?:\/|$)/;

/** gh's stderr for a pull request number the repository does not have. */
const NO_PULL_REQUEST = /Could not resolve to a PullRequest/;

/** The `owner/name` and number of a GitHub URL whose path matches `path`, or null for any other URL. */
function githubUrlOf(target: string, path: RegExp): { repo: string; number: number } | null {
  let url: URL;

  try {
    url = new URL(target);
  } catch {
    return null;
  }

  const [, repo, number] = /^https?:$/.test(url.protocol) && url.hostname === 'github.com' ? (path.exec(url.pathname) ?? []) : [];

  return repo === undefined ? null : { repo, number: Number(number) };
}

/** The `owner/name` and number of a GitHub pull request URL, or null for any other URL. */
function pullRequestOfUrl(target: string): { repo: string; number: number } | null {
  return githubUrlOf(target, PULL_REQUEST_PATH);
}

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
  url?: string;
  author: Actor | null;
}

/** Each comment's anchor id, which its heading shows, such as `[c3]` (PRD R79). */
type CommentIds = Map<Comment, string>;

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
  commits: { nodes: { commit: { committedDate?: string; author?: { user: Actor | null } | null; statusCheckRollup: { state: string } | null } }[] };
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
    /** Reads `config.rolesFile`; called only when it is set. */
    private readonly readRoles: (path: string) => Promise<RolesResult> = async () => ({ roles: new Map() }),
  ) {}

  /**
   * Reads every open issue assigned to a configured login on the project, and lists an issue whose status is not configured as not
   * assigned. With `requireAssignee` off, reads every open issue on the project and lists only those on a configured status. A malformed
   * response is a failed read. An issue of `current` stored as assigned that the search drops or lists outside scope is read on its own.
   */
  async poll(current: readonly Ticket[] = []): Promise<PollResult> {
    try {
      return await this.readIssues(current);
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

  async assignmentAt(target: string) {
    const issue = githubUrlOf(target, ISSUE_PATH);
    return issue?.repo.toLowerCase() === this.config.repo.toLowerCase() ? readAssignment(this.config, this.gh, issue.number) : null;
  }

  /**
   * Refuses a pull request link in the configured repository unless the pull request closes the issue or its branch names it, as the
   * branch of a stacked pull request that does not close the issue does (PRD R52). Other links are not checked.
   */
  async checkLink(ticket: Ticket, target: string): Promise<LinkCheck> {
    const pr = pullRequestOfUrl(target);

    if (pr?.repo.toLowerCase() !== this.config.repo.toLowerCase()) {
      return { refused: null };
    }

    try {
      return await this.checkPullRequest(ticket, pr.number);
    } catch {
      return { error: UNEXPECTED };
    }
  }

  /** Reads the issue at an issue URL in the configured repository, in any spelling of the owner and name; null for any other URL (PRD R83). */
  async ticketAt(target: string): Promise<TicketLookup | null> {
    const issue = githubUrlOf(target, ISSUE_PATH);

    if (issue?.repo.toLowerCase() !== this.config.repo.toLowerCase()) {
      return null;
    }

    const [owner = '', name = ''] = this.config.repo.split('/');
    const result = await this.gh(ISSUE_QUERY, { owner, name, number: issue.number });

    if ('error' in result) {
      return NO_ISSUE.test(result.error) ? { error: `#${issue.number} is not an issue in ${this.config.repo}.` } : result;
    }

    const found = (result.json as { data?: { repository?: { issue?: { number?: unknown; title?: unknown; url?: unknown; state?: unknown } | null } } } | null)?.data?.repository?.issue;

    if (typeof found?.number !== 'number' || typeof found.title !== 'string' || typeof found.url !== 'string' || typeof found.state !== 'string') {
      return { error: UNEXPECTED };
    }

    return { ticket: { sourceKey: String(found.number), ref: `#${found.number}`, title: found.title, url: found.url, open: found.state === 'OPEN' } };
  }

  private async checkPullRequest(ticket: Ticket, number: number): Promise<LinkCheck> {
    const [owner = '', name = ''] = this.config.repo.split('/');
    const result = await this.gh(PULL_REQUEST_QUERY, { owner, name, number });

    if ('error' in result) {
      return NO_PULL_REQUEST.test(result.error) ? { refused: `Pull request #${number} was not found in ${this.config.repo}.` } : result;
    }

    type Closing = { pageInfo: { hasNextPage: boolean }; nodes: { number: number; repository: { nameWithOwner: string } }[] };
    const pr = (result.json as { data: { repository: { pullRequest: { headRefName: string; closingIssuesReferences: Closing } } } }).data.repository.pullRequest;
    const closing = pr.closingIssuesReferences;
    const closes = closing.nodes.some((issue) => String(issue.number) === ticket.sourceKey && issue.repository.nameWithOwner.toLowerCase() === this.config.repo.toLowerCase());

    if (closes || this.keyOfBranch(pr.headRefName) === ticket.sourceKey) {
      return { refused: null };
    }

    return closing.pageInfo.hasNextPage
      ? { error: `pull request #${number} closes more issues than one read lists` }
      : { refused: `Pull request #${number} does not close ${ticket.ref} and its branch ${pr.headRefName} does not name it. Link only the pull request that delivers this work.` };
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

  /**
   * Corrects the search by reading each issue the store holds as assigned that the search drops or lists outside scope, because issue
   * search can answer with a successful but incomplete result during a GitHub outage, which would end every work item (mechanics M48).
   */
  private async confirmLeft(tickets: PolledTicket[], current: readonly Ticket[]): Promise<PollResult> {
    for (const ticket of current) {
      const index = tickets.findIndex((entry) => entry.sourceKey === ticket.sourceKey);

      if (!ticket.assigned || tickets[index]?.assigned === true) {
        continue;
      }

      const read = await readAssigned(this.config, this.gh, Number(ticket.sourceKey));

      if ('error' in read) {
        return { error: `Could not confirm that ${ticket.ref} left the assigned state: ${read.error}` };
      }

      if (read.assigned) {
        const entry: PolledTicket = { sourceKey: ticket.sourceKey, ref: ticket.ref, sourceId: null, title: ticket.title, url: ticket.url, assigned: true, pool: false, sortAt: ticket.sortAt, enteredAt: null };
        tickets.splice(index === -1 ? tickets.length : index, index === -1 ? 0 : 1, entry);
      }
    }

    return { tickets };
  }

  private async readIssues(current: readonly Ticket[]): Promise<PollResult> {
    const { repo, logins, requireAssignee, project, assignedStatuses, maxPages } = this.config;
    const assignees = requireAssignee ? logins.map((login) => `assignee:${login}`) : [];
    const q = [`repo:${repo}`, 'is:issue', 'is:open', ...assignees, `project:${project.owner}/${project.number}`].join(' ');
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
        const assigned = status !== undefined && assignedStatuses.includes(status);

        // Without the assignee filter the search returns the whole board, so only issues in scope are listed. The flow reads an unlisted
        // ticket as having left the assigned state.
        if (!requireAssignee && !assigned) {
          continue;
        }

        tickets.push({
          sourceKey: String(node.number),
          ref: `#${node.number}`,
          sourceId: null,
          title: node.title,
          url: node.url,
          assigned,
          pool: false,
          sortAt: this.waitingSince(node.timelineItems, field?.updatedAt),
          // Scope then starts at a status change, which the timeline no longer logs, so core keeps the time it first saw the issue.
          enteredAt: requireAssignee ? this.assignedSince(node as IssueNode) : null,
        });
      }

      if (!search.pageInfo.hasNextPage) {
        return this.confirmLeft(tickets, current);
      }

      after = search.pageInfo.endCursor;
    }

    return { error: `More than ${maxPages} pages of searched issues; raise sources.github.maxPages.` };
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
    const roles = this.config.rolesFile === null ? { roles: new Map() } : await this.readRoles(this.config.rolesFile);
    const links = pr === null ? [] : [{ label: `Pull request #${pr.number}`, target: pr.url }];
    const { anchors, ids } = anchorsOf(issue, pr);
    const context = this.format(issue, pr, 'roles' in roles ? roles.roles : new Map(), ids);
    const activityAt = this.activityAt(issue, pr);

    return 'error' in roles ? { context, links, anchors, activityAt, warning: `${roles.error} Comment authors show no roles.` } : { context, links, anchors, activityAt };
  }

  /**
   * The latest comment, review or pull request head commit in the context by anyone but the operator's logins, bots included (PRD R80). A status
   * or assignment change asks for no action on its own, and the operator's own comments and commits, such as a session's, ask nothing of the operator.
   */
  private activityAt(issue: ContextIssue, pr: PullRequest | null): number | null {
    const own = new Set(this.config.logins.map((login) => login.toLowerCase()));
    const comments = [...issue.comments.nodes, ...(pr === null ? [] : [...pr.comments.nodes, ...pr.reviewThreads.nodes.flatMap((thread) => thread.comments.nodes)])];
    const entries = [
      ...comments.map((comment) => ({ author: comment.author, at: comment.createdAt })),
      ...(pr?.reviews.nodes ?? []).map((review) => ({ author: review.author, at: review.submittedAt })),
      // A commit whose author has no GitHub account counts as someone else's.
      ...(pr?.commits.nodes ?? []).map(({ commit }) => ({ author: commit.author?.user ?? null, at: commit.committedDate })),
    ];
    const times = entries
      .filter((entry) => !own.has((entry.author?.login ?? 'ghost').toLowerCase()))
      .map((entry) => Date.parse(entry.at ?? ''))
      .filter((time) => !Number.isNaN(time));

    return times.length === 0 ? null : Math.max(...times);
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

  private format(issue: ContextIssue, pr: PullRequest | null, roles: Roles, ids: CommentIds): string {
    // GitHub stopped logging status events around 2026-09-25, so the Status field is the current status.
    const field = issue.projectItems.nodes.find((item) => this.onProject(item.project))?.fieldValueByName;
    const lines = [
      `GitHub issue #${issue.number}: ${issue.title} [ticket]`,
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
        lines.push('', commentHeading(comment, roles, ids), clip(comment.body, TEXT_LIMIT));
      }
    }

    if (pr !== null) {
      lines.push('', ...pullRequestLines(pr, roles, ids));
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

/** The author's roles from the roles file follow the login, and the anchor id ends it, as `### QaTester (tester), 2026-10-06 14:02 [c3]`. */
function commentHeading(comment: Comment, roles: Roles, ids: CommentIds): string {
  const login = comment.author?.login ?? 'ghost';
  const listed = roles.get(login.toLowerCase());
  const id = ids.get(comment);

  return `### ${login}${listed === undefined ? '' : ` (${listed.join(', ')})`}, ${comment.createdAt.slice(0, 16).replace('T', ' ')}${id === undefined ? '' : ` [${id}]`}`;
}

/**
 * The pages and comments triage can choose as the focus (PRD R79): the issue, the pull request in the context, and each comment with a URL,
 * numbered `c1`, `c2`… by creation time across the issue, pull request and review threads, so the lowest is the earliest.
 */
function anchorsOf(issue: ContextIssue, pr: PullRequest | null): { anchors: Anchor[]; ids: CommentIds } {
  const comments = [
    ...issue.comments.nodes.map((comment) => ({ comment, page: 'ticket' as const })),
    ...(pr === null ? [] : [...pr.comments.nodes, ...pr.reviewThreads.nodes.flatMap((thread) => thread.comments.nodes)].map((comment) => ({ comment, page: 'pr' as const }))),
  ].filter((entry) => entry.comment.url !== undefined);
  // A stable sort keeps the section order for comments made in the same second.
  const ordered = comments.sort((a, b) => a.comment.createdAt.localeCompare(b.comment.createdAt));
  const ids: CommentIds = new Map(ordered.map((entry, index) => [entry.comment, `c${index + 1}`]));
  const anchors: Anchor[] = [
    { id: 'ticket', url: issue.url, page: 'ticket' },
    ...(pr === null ? [] : [{ id: 'pr', url: pr.url, page: 'pr' as const }]),
    ...ordered.map((entry) => ({ id: ids.get(entry.comment)!, url: entry.comment.url!, page: entry.page })),
  ];

  return { anchors, ids };
}

/** The most recently updated open closing pull request, else the most recently updated one (GC selectPullRequest). */
function pullRequestOf(nodes: PullRequest[]): PullRequest | null {
  const byRecency = [...nodes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return byRecency.find((pr) => pr.state === 'OPEN') ?? byRecency[0] ?? null;
}

function pullRequestLines(pr: PullRequest, roles: Roles, ids: CommentIds): string[] {
  const head = pr.commits.nodes[0]?.commit;
  const checks = head?.statusCheckRollup?.state ?? 'none';
  // The head commit's author and time let triage see a push since earlier work (PRD R80).
  const pushed = head?.committedDate === undefined ? '' : ` Head commit: ${head.author?.user?.login ?? 'ghost'}, ${head.committedDate.slice(0, 16).replace('T', ' ')}.`;
  const lines = [
    `## Pull request #${pr.number}: ${pr.title} [pr]`,
    pr.url,
    `Author: ${pr.author?.login ?? 'ghost'}. State: ${pr.state}${pr.isDraft ? ' (draft)' : ''}. Checks: ${checks}.${pushed}`,
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
      lines.push(commentHeading(comment, roles, ids), clip(comment.body, TEXT_LIMIT));
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
        lines.push(commentHeading(comment, roles, ids), clip(comment.body, TEXT_LIMIT));
      }
    }
  }

  return lines;
}
