import type { AssignmentLookup } from '@switchboard/core';
import type { GithubConfig } from './config.js';
import type { Gh } from './gh.js';

export const ASSIGNMENT_QUERY = `query($owner:String!, $name:String!, $number:Int!, $status:String!, $before:String){
  repository(owner:$owner,name:$name){issue(number:$number){
    id number title url state updatedAt
    assignees(first:100){nodes{login} pageInfo{hasNextPage}}
    projectItems(first:100){pageInfo{hasNextPage} nodes{
      project{number owner{... on Organization{login} ... on User{login}}}
      fieldValueByName(name:$status){... on ProjectV2ItemFieldSingleSelectValue{name}}
    }}
    timelineItems(last:100,before:$before,itemTypes:[ASSIGNED_EVENT,UNASSIGNED_EVENT]){
      pageInfo{hasPreviousPage startCursor}
      nodes{__typename ... on AssignedEvent{id assignee{... on User{login} ... on Bot{login}}}
        ... on UnassignedEvent{id assignee{... on User{login} ... on Bot{login}}}}
    }
  }}
}`;

interface AssignmentIssue {
  id: string; number: number; title: string; url: string; state: string; updatedAt: string;
  assignees: { nodes: { login: string }[]; pageInfo: { hasNextPage: boolean } };
  projectItems: { pageInfo: { hasNextPage: boolean }; nodes: { project: { number: number; owner: { login: string } }; fieldValueByName: { name: string } | null }[] };
  timelineItems: {
    pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
    nodes: { __typename: string; id: string; assignee: { login?: string } | null }[];
  };
}

/** gh's stderr for an issue number the repository does not have, or that is a pull request. */
export const NO_ISSUE = /Could not resolve to an Issue/;

type IssueRead = { issue: AssignmentIssue | null; names: string[]; assigned: boolean } | { error: string };

/** One read of the issue: its assignees and whether it is in the assigned state; `issue` is null when GitHub has no such issue. */
async function readIssue(config: GithubConfig, gh: Gh, number: number, before: string | null): Promise<IssueRead> {
  const [owner = '', name = ''] = config.repo.split('/');
  const own = new Set(config.logins.map((login) => login.toLowerCase()));
  const result = await gh(ASSIGNMENT_QUERY, { owner, name, number, status: config.project.statusField, ...(before === null ? {} : { before }) });
  if ('error' in result) return result;
  const issue = (result.json as { data: { repository: { issue: AssignmentIssue | null } } }).data.repository.issue;
  if (issue === null) return { issue, names: [], assigned: false };
  if (typeof issue.id !== 'string' || issue.number !== number || typeof issue.title !== 'string' || typeof issue.url !== 'string' || !['OPEN', 'CLOSED'].includes(issue.state) || typeof issue.updatedAt !== 'string' || issue.assignees.pageInfo.hasNextPage !== false) {
    return { error: 'GitHub returned incomplete assignment data.' };
  }
  const names = issue.assignees.nodes.map(({ login }) => login.toLowerCase()).sort();
  if (issue.projectItems.pageInfo.hasNextPage !== false) return { error: 'GitHub returned incomplete project membership.' };
  const status = issue.projectItems.nodes.find(({ project }) => project.number === config.project.number && project.owner.login.toLowerCase() === config.project.owner.toLowerCase())?.fieldValueByName?.name;
  const assigned = issue.state === 'OPEN' && status !== undefined && config.assignedStatuses.includes(status) && (!config.requireAssignee || names.some((login) => own.has(login)));
  return { issue, names, assigned };
}

/** Whether the issue is in the assigned state, read from the issue itself rather than issue search; a missing issue is not. */
export async function readAssigned(config: GithubConfig, gh: Gh, number: number): Promise<{ assigned: boolean } | { error: string }> {
  try {
    const read = await readIssue(config, gh, number, null);
    if ('error' in read) {
      // gh reports every GraphQL error; another one beside the missing issue leaves the read failed.
      const lines = read.error.split('\n').filter((line) => line.trim() !== '');
      return lines.length > 0 && lines.every((line) => NO_ISSUE.test(line)) ? { assigned: false } : read;
    }
    return { assigned: read.assigned };
  } catch {
    return { error: 'GitHub returned unexpected assignment data.' };
  }
}

/** Walks assignment events backwards to the beginning of the current continuous operator assignment. */
export async function readAssignment(config: GithubConfig, gh: Gh, number: number): Promise<AssignmentLookup> {
  const own = new Set(config.logins.map((login) => login.toLowerCase()));
  let held: Set<string> | null = null;
  let snapshot: string | null = null;
  let before: string | null = null;

  try {
    for (let page = 0; page < config.maxPages; page++) {
      const read = await readIssue(config, gh, number, before);
      if ('error' in read) return read;
      const { issue, names, assigned } = read;
      if (issue === null) return { error: `Issue #${number} was not found.` };
      const current = JSON.stringify([issue.updatedAt, names]);
      if (snapshot !== null && snapshot !== current) return { error: `Assignment changed while reading #${number}; retry.` };
      snapshot = current;
      held ??= new Set(names.filter((login) => own.has(login)));
      const ticket = { sourceKey: String(number), ref: `#${number}`, title: issue.title, url: issue.url, open: issue.state === 'OPEN' };
      if (held.size === 0) return { ticket, assignmentKey: null, assigned };

      for (const event of [...issue.timelineItems.nodes].reverse()) {
        if (!['AssignedEvent', 'UnassignedEvent'].includes(event.__typename) || typeof event.id !== 'string') return { error: 'GitHub returned incomplete assignment events.' };
        const login = event.assignee?.login?.toLowerCase();
        if (login === undefined || !own.has(login)) continue;
        if (event.__typename === 'UnassignedEvent') held.add(login);
        else {
          held.delete(login);
          if (held.size === 0) return { ticket, assignmentKey: `${issue.id}:${event.id}`, assigned };
        }
      }
      const info = issue.timelineItems.pageInfo;
      if (info.hasPreviousPage !== true || !info.startCursor || info.startCursor === before) break;
      before = info.startCursor;
    }
    return { error: `Could not establish the operator assignment for #${number}; assignment history is incomplete.` };
  } catch {
    return { error: 'GitHub returned unexpected assignment data.' };
  }
}
