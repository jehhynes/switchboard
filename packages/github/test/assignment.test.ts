import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { readAssignment, ASSIGNMENT_QUERY } from '../src/assignment.js';
import { parseGithubConfig } from '../src/config.js';
import type { Gh } from '../src/gh.js';
import { GithubSource } from '../src/source.js';

const parsed = parseGithubConfig({ repo: 'acme/widgets', logins: ['work-login', 'work-ai-login'], project: { owner: 'acme', number: 3, statusField: 'Status' }, assignedStatuses: ['Dev'] });
if ('error' in parsed) throw new Error(parsed.error);
const config = parsed.config;
const event = (id: string, login = 'work-login', type = 'AssignedEvent') => ({ id, __typename: type, assignee: { login } });
function issue(events = [event('a1')], logins = ['work-login']) {
  return { id: 'I1', number: 7, title: 'Issue 7', url: 'https://github.com/acme/widgets/issues/7', state: 'OPEN', updatedAt: '2026-10-19T12:00:00Z',
    assignees: { nodes: logins.map((login) => ({ login })), pageInfo: { hasNextPage: false } },
    projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ project: { number: 3, owner: { login: 'acme' } }, fieldValueByName: { name: 'Dev' } }] },
    timelineItems: { pageInfo: { hasPreviousPage: false, startCursor: 'cursor' }, nodes: events } };
}
const response = (value: unknown) => ({ json: { data: { repository: { issue: value } } } });

describe('operator assignment identity', () => {
  it('reads the recorded and scrubbed GitHub assignment response', async () => {
    const json: unknown = JSON.parse(readFileSync(new URL('./fixtures/assignment.json', import.meta.url), 'utf8'));
    expect(await readAssignment(config, vi.fn<Gh>().mockResolvedValue({ json }), 7)).toMatchObject({ assignmentKey: 'I1:event-1', assigned: true, ticket: { sourceKey: '7', open: true } });
  });
  it('uses event identity, independent of status, and reads URLs only from its repository', async () => {
    const data = issue();
    const gh = vi.fn<Gh>().mockResolvedValue(response(data));
    const source = new GithubSource(config, gh);
    expect(await source.assignmentAt(data.url)).toMatchObject({ assignmentKey: 'I1:a1', assigned: true });
    data.projectItems.nodes = [];
    expect(await source.assignmentAt(data.url)).toMatchObject({ assignmentKey: 'I1:a1', assigned: false });
    data.timelineItems.nodes = [event('a1'), event('u1', 'work-login', 'UnassignedEvent'), event('a2')];
    expect(await source.assignmentAt(data.url)).toMatchObject({ assignmentKey: 'I1:a2' });
    expect(await source.assignmentAt('https://example.com/acme/widgets/issues/7')).toBeNull();
    expect(gh).toHaveBeenCalledTimes(3);
    expect(gh).toHaveBeenCalledWith(ASSIGNMENT_QUERY, { owner: 'acme', name: 'widgets', number: 7, status: 'Status' });
  });

  it('walks all configured logins across pages to the continuous assignment start', async () => {
    const recent = issue([event('u1', 'work-login', 'UnassignedEvent'), event('a2')], ['work-login', 'work-ai-login']);
    recent.timelineItems.pageInfo.hasPreviousPage = true;
    const older = issue([event('start'), event('other', 'work-ai-login')], ['work-login', 'work-ai-login']);
    const gh = vi.fn<Gh>().mockResolvedValueOnce(response(recent)).mockResolvedValueOnce(response(older));
    expect(await readAssignment(config, gh, 7)).toMatchObject({ assignmentKey: 'I1:start' });
    expect(gh.mock.calls[1]?.[1]['before']).toBe('cursor');
  });

  it('reports actual unassignment and respects requireAssignee=false eligibility without inventing an identity', async () => {
    const gh = vi.fn<Gh>().mockResolvedValue(response(issue([], ['another-user'])));
    expect(await readAssignment(config, gh, 7)).toMatchObject({ assignmentKey: null, assigned: false });
    expect(await readAssignment({ ...config, requireAssignee: false }, gh, 7)).toMatchObject({ assignmentKey: null, assigned: true });
  });

  it('refuses incomplete history and an assignment changed during pagination', async () => {
    const recent = issue([event('foreign', 'someone')]);
    recent.timelineItems.pageInfo.hasPreviousPage = true;
    const gh = vi.fn<Gh>().mockResolvedValue(response(recent));
    expect(await readAssignment({ ...config, maxPages: 1 }, gh, 7)).toHaveProperty('error');
    const changed = issue();
    changed.updatedAt = '2026-10-19T12:00:01Z';
    gh.mockReset().mockResolvedValueOnce(response(recent)).mockResolvedValueOnce(response(changed));
    expect(await readAssignment(config, gh, 7)).toEqual({ error: 'Assignment changed while reading #7; retry.' });
  });

  it.each([null, {}, { ...issue(), assignees: { ...issue().assignees, pageInfo: { hasNextPage: true } } }, { ...issue(), projectItems: { ...issue().projectItems, pageInfo: { hasNextPage: true } } }, issue([{ ...event('a1'), __typename: 'Unknown' }]), issue([])])('refuses malformed or incomplete data %#', async (data) => {
    expect(await readAssignment(config, vi.fn<Gh>().mockResolvedValue(response(data)), 7)).toHaveProperty('error');
  });

  it('returns read failures without an assignment decision', async () => {
    expect(await readAssignment(config, vi.fn<Gh>().mockResolvedValue({ error: 'offline' }), 7)).toEqual({ error: 'offline' });
  });
});
