import { describe, expect, it } from 'vitest';
import { activeSession, groupOf, triageLabel, urlKey } from '../src/group.js';
import type { SessionState, WorkItemStatus } from '../src/model.js';

const item = (status: WorkItemStatus, ...states: SessionState[]) => ({ status, sessions: states.map((state) => ({ state })) });

describe('groupOf', () => {
  it('checks Done, then Unstarted, then Needs you, then Working (PRD R27)', () => {
    expect(groupOf(item('done', 'waiting'))).toBe('done');
    expect(groupOf(item('triaging'))).toBe('unstarted');
    expect(groupOf(item('unstarted'))).toBe('unstarted');
    expect(['awaiting-approval', 'blocked', 'failed'].map((status) => groupOf(item(status as WorkItemStatus)))).toEqual(['needs', 'needs', 'needs']);
    expect(groupOf(item('running', 'ended', 'waiting'))).toBe('needs');
    expect(['queued', 'setup', 'running'].map((status) => groupOf(item(status as WorkItemStatus, 'ended', 'running')))).toEqual(['working', 'working', 'working']);
  });
});

describe('activeSession', () => {
  it('returns the first session that has not ended, or null', () => {
    expect(activeSession(item('running', 'ended', 'idle'))).toEqual({ state: 'idle' });
    expect(activeSession(item('blocked', 'ended'))).toBeNull();
  });
});

describe('triageLabel', () => {
  it('names the source\'s namespace, or plain triage without one', () => {
    expect(triageLabel('github', { github: 'dev' })).toBe('dev:triage');
    expect(triageLabel('github', { github: '' })).toBe('triage');
    expect(triageLabel('zoho', { github: 'dev' })).toBe('triage');
  });
});

describe('urlKey', () => {
  it('reduces a GitHub issue or pull request page, any tab included, to its owner, repo, kind and number in lower case (PRD R69)', () => {
    expect(urlKey('https://github.com/Acme/Widgets/issues/18941')).toBe('github.com/acme/widgets/issues/18941');
    expect(urlKey('https://GitHub.com/o/r/pull/7/files?w=1#diff')).toBe('github.com/o/r/pull/7');
    expect(urlKey('https://github.com/o/r/issues/7/')).toBe('github.com/o/r/issues/7');
  });

  it('keeps other GitHub pages apart from issues, and pull requests apart from issues', () => {
    expect(urlKey('https://github.com/o/r/issues/7')).not.toBe(urlKey('https://github.com/o/r/pull/7'));
    expect(urlKey('https://github.com/o/r/issues/7x')).toBe('https://github.com/o/r/issues/7x');
    expect(urlKey('https://github.com/o/r/issues')).toBe('https://github.com/o/r/issues');
  });

  it('keeps another URL whole but for a trailing slash, and leaves text that is not a URL as it is', () => {
    expect(urlKey('https://Desk.Example.test/agent/tickets/123/')).toBe('https://desk.example.test/agent/tickets/123');
    expect(urlKey('https://desk.example.test/t?id=5#c')).toBe('https://desk.example.test/t?id=5#c');
    expect(urlKey('not a url/')).toBe('not a url/');
  });
});