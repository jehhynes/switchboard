import { describe, expect, it } from 'vitest';
import { activeSession, groupOf, triageLabel } from '../src/group.js';
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
