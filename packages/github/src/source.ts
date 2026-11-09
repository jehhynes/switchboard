import type { Anchor, ContextResult, LinkCheck, PolledTicket, PollResult, Source, Ticket, TicketBlocker, TicketLookup } from '@switchboard/core';
import { clip } from '@switchboard/core';
import type { GithubConfig } from './config.js';
import { inAssignedStatus } from './config.js';
import type { Gh } from './gh.js';
import { CONTEXT_QUERY, FIELD_QUERY, ISSUE_QUERY, ISSUES_QUERY, PULL_REQUEST_QUERY } from './queries.js';
import type { Roles, RolesResult } from './roles.js';
import { NO_ISSUE, readAssigned, readAssignment } from './assignment.js';
import { keyOf, ownerName, parseKey, refOf } from './keys.js';
import type { IssueId } from './keys.js';

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
  __typename?: string;
}

/** The login, with `(bot)` for a bot account, whose GraphQL login has no `[bot]` suffix, such as the Claude app's `claude`. */
function actorName(actor: Actor | null | undefined, fallback: string): string {
  return actor === null || actor === undefined ? fallback : actor.__typename === 'Bot' ? `${actor.login} (bot)` : actor.login;
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
  repository: { nameWithOwner: string };
  projectItems: ProjectItems;
  assignees?: { nodes: { login: string }[] };
  blockedBy?: { nodes: ({ number: number; title: string; url: string; state: string; repository: { nameWithOwner: string } } | null)[] };
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
  submittedReviews: { totalCount: number; nodes: { submittedAt: string | null; author: Actor | null }[] };
  allComments: { totalCount: number; nodes: { createdAt: string; author: Actor | null }[] };
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
  constructor(
    private readonly config: GithubConfig,
    private readonly gh: Gh,
    /** Reads `config.rolesFile`; called only when it is set. */
    private readonly readRoles: (path: string) => Promise<RolesResult> = async () => ({ roles: new Map() }),
    readonly name = 'github',
  ) {}

  /**
   * Reads every open issue assigned to a configured login on the project, and lists an issue whose status is not configured as not
   * assigned. With `requireAssignee` off, reads every open issue on the project and lists only those on a configured status, or on any
   * status while none is configured. With `includeClosed`, closed issues are read too. A malformed response is a failed read. An issue of `current` stored as assigned that the search drops or lists outside scope is read on its own.
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

  /** The key of the issue a branch of `repo` names, such as `63-fix` in `acme/widgets-dashboard` (PRD R25). */
  keyOfBranch(branch: string, repo: string): string | null {
    const number = this.config.branchPattern.exec(branch)?.[1];

    return number === undefined || !/^\d+$/.test(number) ? null : keyOf(this.config.repo, repo, Number(number));
  }

  /**
   * The operator's assignment of the issue at an issue URL in any repository: null for another URL, or, unless `anyBoard`, for an issue that
   * is not on the source's board, so another source can answer (PRD R85).
   */
  async assignmentAt(target: string, anyBoard = false) {
    const issue = this.issueOfUrl(target);
    return issue === null ? null : readAssignment(this.config, this.gh, issue, !anyBoard);
  }

  private issueOfUrl(target: string): IssueId | null {
    const issue = githubUrlOf(target, ISSUE_PATH);
    return issue === null ? null : { repo: issue.repo.toLowerCase(), number: issue.number };
  }

  private idOf(ticket: Ticket): IssueId {
    const id = parseKey(this.config.repo, ticket.sourceKey);

    if (id === null) {
      throw new Error(`${ticket.sourceKey} is not a GitHub issue key.`);
    }

    return id;
  }

  /**
   * Refuses a GitHub pull request link, read in its own repository, unless it closes the issue, matched on repository and number, or, in the
   * issue's own repository, its branch names it, as the branch of a stacked pull request that does not close the issue does (PRD R52). Other
   * links are not checked.
   */
  async checkLink(ticket: Ticket, target: string): Promise<LinkCheck> {
    const pr = pullRequestOfUrl(target);

    if (pr === null) {
      return { refused: null };
    }

    try {
      return await this.checkPullRequest(ticket, this.idOf(ticket), { repo: pr.repo.toLowerCase(), number: pr.number });
    } catch {
      return { error: UNEXPECTED };
    }
  }

  /**
   * Reads the issue at an issue URL in any repository and spelling of the owner and name: null for any other URL, and for an issue that is not
   * on the source's board in any status, so another source can answer (PRD R83).
   */
  async ticketAt(target: string): Promise<TicketLookup | null> {
    const issue = this.issueOfUrl(target);

    if (issue === null) {
      return null;
    }

    const result = await this.gh(ISSUE_QUERY, { ...ownerName(issue.repo), number: issue.number });
    const ref = refOf(this.config.repo, issue.repo, issue.number);

    if ('error' in result) {
      return NO_ISSUE.test(result.error) ? { error: `${ref} is not an issue.` } : result;
    }

    type Found = { number?: unknown; title?: unknown; url?: unknown; state?: unknown; projectItems?: { pageInfo?: { hasNextPage?: unknown }; nodes?: { project: ProjectRef | null }[] } };
    const found = (result.json as { data?: { repository?: { issue?: Found | null } } } | null)?.data?.repository?.issue;

    if (typeof found?.number !== 'number' || typeof found.title !== 'string' || typeof found.url !== 'string' || typeof found.state !== 'string' || !Array.isArray(found.projectItems?.nodes)) {
      return { error: UNEXPECTED };
    }

    if (found.projectItems.pageInfo?.hasNextPage !== false) {
      return { error: 'GitHub returned incomplete project membership.' };
    }

    if (!found.projectItems.nodes.some((item) => this.onProject(item.project))) {
      return null;
    }

    return { ticket: { sourceKey: keyOf(this.config.repo, issue.repo, found.number), ref, repo: issue.repo, title: found.title, url: found.url, open: found.state === 'OPEN' || this.config.includeClosed } };
  }

  private async checkPullRequest(ticket: Ticket, id: IssueId, { repo, number }: IssueId): Promise<LinkCheck> {
    const result = await this.gh(PULL_REQUEST_QUERY, { ...ownerName(repo), number });

    if ('error' in result) {
      return NO_PULL_REQUEST.test(result.error) ? { refused: `Pull request #${number} was not found in ${repo}.` } : result;
    }

    type Closing = { pageInfo: { hasNextPage: boolean }; nodes: { number: number; repository: { nameWithOwner: string } }[] };
    const pr = (result.json as { data: { repository: { pullRequest: { headRefName: string; closingIssuesReferences: Closing } } } }).data.repository.pullRequest;
    const closing = pr.closingIssuesReferences;
    const closes = closing.nodes.some((issue) => issue.number === id.number && issue.repository.nameWithOwner.toLowerCase() === id.repo);

    if (closes || (repo === id.repo && this.keyOfBranch(pr.headRefName, id.repo) === ticket.sourceKey)) {
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

  /** The open issues blocking an issue, none while `waitForBlockers` is off (PRD R90); `blockedBy` also lists closed ones (mechanics M56). */
  private blockers(node: IssueNode): TicketBlocker[] {
    if (!this.config.waitForBlockers) {
      return [];
    }

    return (node.blockedBy?.nodes ?? []).flatMap((issue) => {
      if (issue === null || issue.state !== 'OPEN') {
        return [];
      }

      const repo = issue.repository.nameWithOwner;

      return [{ url: issue.url, ref: repo.toLowerCase() === this.config.repo ? `#${issue.number}` : `${repo}#${issue.number}`, title: issue.title }];
    });
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

      const read = await readAssigned(this.config, this.gh, this.idOf(ticket));

      if ('error' in read) {
        return { error: `Could not confirm that ${ticket.ref} left the assigned state: ${read.error}` };
      }

      if (read.assigned) {
        // The search's blockers are current; an issue missing from the search keeps the stored ones, or none while the check is off (PRD R90).
        const blockers = this.config.waitForBlockers ? tickets[index]?.blockers : [];
        const entry: PolledTicket = { sourceKey: ticket.sourceKey, ref: ticket.ref, repo: ticket.repo, sourceId: null, title: ticket.title, url: ticket.url, assigned: true, pool: false, sortAt: ticket.sortAt, enteredAt: null, ...(blockers === undefined ? {} : { blockers }) };
        tickets.splice(index === -1 ? tickets.length : index, index === -1 ? 0 : 1, entry);
      }
    }

    return { tickets };
  }

  private async readIssues(current: readonly Ticket[]): Promise<PollResult> {
    const { repo: home, logins, requireAssignee, includeClosed, project, maxPages } = this.config;
    const assignees = requireAssignee ? logins.map((login) => `assignee:${login}`) : [];
    // The board, not a repository, scopes the search, so every repository on it is read in one search (mechanics M59). Without `is:open`
    // the search returns both states (mechanics M60).
    const q = ['is:issue', ...(includeClosed ? [] : ['is:open']), ...assignees, `project:${project.owner}/${project.number}`].join(' ');
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

        const item = node.projectItems.nodes.find((entry) => this.onProject(entry.project));
        const field = item?.fieldValueByName;
        // An issue on more projects than the query reads has no item for the board, and is not assigned.
        const assigned = item !== undefined && inAssignedStatus(this.config, field?.name);

        // Without the assignee filter the search returns the whole board, so only issues in scope are listed. The flow reads an unlisted
        // ticket as having left the assigned state.
        if (!requireAssignee && !assigned) {
          continue;
        }

        const repo = node.repository.nameWithOwner.toLowerCase();

        tickets.push({
          sourceKey: keyOf(home, repo, node.number),
          ref: refOf(home, repo, node.number),
          repo,
          sourceId: null,
          title: node.title,
          url: node.url,
          assigned,
          pool: false,
          sortAt: this.waitingSince(node.timelineItems, field?.updatedAt),
          // Scope then starts at a status change, which the timeline no longer logs, so core keeps the time it first saw the issue.
          enteredAt: requireAssignee ? this.assignedSince(node as IssueNode) : null,
          blockers: this.blockers(node as IssueNode),
        });
      }

      if (!search.pageInfo.hasNextPage) {
        return this.confirmLeft(tickets, current);
      }

      after = search.pageInfo.endCursor;
    }

    return { error: `More than ${maxPages} pages of searched issues; raise sources.${this.name}.maxPages.` };
  }

  private async readContext(ticket: Ticket): Promise<ContextResult> {
    const id = this.idOf(ticket);
    const result = await this.gh(CONTEXT_QUERY, { ...ownerName(id.repo), number: id.number, status: this.config.project.statusField });

    if ('error' in result) {
      return result;
    }

    const issue = (result.json as { data?: { repository?: { issue?: ContextIssue | null } } } | null)?.data?.repository?.issue;

    if (issue === undefined || issue === null) {
      return { error: `Issue ${id.number} was not found in ${id.repo}.` };
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
    const missing = `Project ${owner}/${number} has no field named "${statusField}". Set sources.${this.name}.project.statusField.`;
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
    return project?.number === this.config.project.number && project.owner?.login?.toLowerCase() === this.config.project.owner.toLowerCase();
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
      lines.push('', ...pullRequestLines(pr, roles, ids, this.config.logins));
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
    const who = actorName(event.actor, 'someone');
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

/**
 * `bot` for a bot account and the author's roles from the roles file follow the login, and the anchor id ends it, as
 * `### QaTester (tester), 2026-10-06 14:02 [c3]` or `### claude (bot), 2026-10-29 12:43 [c3]`.
 */
function commentHeading(comment: Comment, roles: Roles, ids: CommentIds): string {
  const login = comment.author?.login ?? 'ghost';
  const labels = [...(comment.author?.__typename === 'Bot' ? ['bot'] : []), ...(roles.get(login.toLowerCase()) ?? [])];
  const id = ids.get(comment);

  return `### ${login}${labels.length === 0 ? '' : ` (${labels.join(', ')})`}, ${comment.createdAt.slice(0, 16).replace('T', ' ')}${id === undefined ? '' : ` [${id}]`}`;
}

/**
 * The operator's submitted reviews and pull request comments, counted in code so triage need not read them from the lists (PRD R1). Bots,
 * other people and pending reviews do not count; review-thread replies belong to a review.
 */
function ownActivityLine(pr: PullRequest, logins: readonly string[]): string {
  const own = new Set(logins.map((login) => login.toLowerCase()));
  const mine = (author: Actor | null) => author !== null && own.has(author.login.toLowerCase());
  const part = (times: string[], noun: string) => `${times.length} ${noun}${times.length === 1 ? '' : 's'}, the latest ${times.sort().at(-1)!.slice(0, 16).replace('T', ' ')}`;
  const reviews = pr.submittedReviews.nodes.filter((review) => mine(review.author) && review.submittedAt !== null).map((review) => review.submittedAt!);
  const comments = pr.allComments.nodes.filter((comment) => mine(comment.author)).map((comment) => comment.createdAt);
  const parts = [...(reviews.length === 0 ? [] : [part(reviews, 'review')]), ...(comments.length === 0 ? [] : [part(comments, 'comment')])];
  // Without a match, a list cut at 100 cannot show that none exists, so the line says what was not read.
  const unread = [pr.submittedReviews, pr.allComments].some((list) => list.totalCount > list.nodes.length);
  const none = unread ? `none in the last ${pr.submittedReviews.nodes.length} of ${pr.submittedReviews.totalCount} reviews and last ${pr.allComments.nodes.length} of ${pr.allComments.totalCount} comments; older ones were not read` : 'none';

  return `Your submitted reviews and pull request comments: ${parts.length === 0 ? none : parts.join('; ')}.`;
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

function pullRequestLines(pr: PullRequest, roles: Roles, ids: CommentIds, logins: readonly string[]): string[] {
  const head = pr.commits.nodes[0]?.commit;
  const checks = head?.statusCheckRollup?.state ?? 'none';
  // The head commit's author and time let triage see a push since earlier work (PRD R80).
  const pushed = head?.committedDate === undefined ? '' : ` Head commit: ${head.author?.user?.login ?? 'ghost'}, ${head.committedDate.slice(0, 16).replace('T', ' ')}.`;
  const lines = [
    `## Pull request #${pr.number}: ${pr.title} [pr]`,
    pr.url,
    `Author: ${actorName(pr.author, 'ghost')}. State: ${pr.state}${pr.isDraft ? ' (draft)' : ''}. Checks: ${checks}.${pushed}`,
  ];

  // On the operator's own pull request the count says nothing about reviewing it.
  if (!logins.some((login) => login.toLowerCase() === pr.author?.login.toLowerCase())) {
    lines.push(ownActivityLine(pr, logins));
  }

  lines.push('', clip(pr.body, TEXT_LIMIT) || '(empty)');

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
    lines.push('', '### Reviews', ...pr.reviews.nodes.map((review) => `${review.submittedAt?.slice(0, 16).replace('T', ' ') ?? ''} ${actorName(review.author, 'ghost')}: ${review.state}`));
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
