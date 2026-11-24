import { describe, expect, it } from 'vitest';
import { Harness, playbooks, settings } from './flowHarness.js';
import type { FlowEvent } from '../src/flow.js';

describe('session provider choice', () => {
  it.each(['claude', 'codex'] as const)('starts a standalone %s session independently of the default', provider => {
    const h = new Harness({ settings: settings({ sessions: { provider: provider === 'claude' ? 'codex' : 'claude', codeMode: true } }) });
    const actions = h.act({ type: 'new-session', repoRoot: 'D:/folder', provider });
    expect(actions).toMatchObject([{ type: 'start-session', provider }]);
    expect(h.store.session('s1')?.provider).toBe(provider);
    expect(h.item(1).provider).toBe(provider);
    expect(h.settings.sessions.provider).toBe(provider === 'claude' ? 'codex' : 'claude');
    h.store.close();
  });

  it('checks the chosen provider prerequisites and refuses invalid input before creating work', () => {
    const h = new Harness({ settings: settings({ sessions: { provider: 'codex', codeMode: false, installHooks: false } }) });
    const event = { type: 'new-session', repoRoot: 'D:/folder' } as const;
    expect(h.send({ ...event, provider: 'claude' }).refused).toBe('Claude sessions need sessions.installHooks.');
    expect(h.send({ ...event, provider: 'other' } as unknown as FlowEvent).refused).toBe('Choose Claude or Codex.');
    expect(h.store.activeSessions()).toHaveLength(0);
    expect(h.act({ ...event, provider: 'codex' })).toMatchObject([{ provider: 'codex', execution: 'app-server' }]);
    expect(h.item(1).id).toBe(1);
    h.store.close();
  });

  it('keeps an ad-hoc choice through a delayed start, failure and retry', () => {
    const h = new Harness({ settings: settings({ sessions: { provider: 'codex' } }) });
    h.act({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/folder', provider: 'codex' });
    expect(h.item(1)).toMatchObject({ provider: 'codex', status: 'unstarted' });
    h.settings.sessions.provider = 'claude';
    expect(h.act({ type: 'start', workItemId: 1 })).toMatchObject([{ type: 'start-session', provider: 'codex' }]);
    h.act({ type: 'session-start-failed', sessionId: 's1', message: 'temporary failure' });
    expect(h.act({ type: 'retry', workItemId: 1 })).toMatchObject([{ type: 'start-session', provider: 'codex' }]);
    expect(h.send({ type: 'adhoc', prompt: 'No', repoRoot: 'D:/folder', provider: null } as unknown as FlowEvent).refused).toBe('Choose Claude or Codex.');
    h.store.close();
  });

  it('starts a playbook taken over from a chosen Codex work item in the provider its options were checked against', () => {
    const h = new Harness({
      settings: settings({ sessions: { provider: 'claude' } }),
      playbooks: playbooks([], { 'dev:review': { description: 'Review', template: 'Review.', permissionMode: 'acceptEdits', model: 'claude-sonnet-5' } }),
    });
    h.started(h.act({ type: 'adhoc', prompt: 'Implement', repoRoot: 'D:/git/widgets', start: true, provider: 'codex' })[0]);
    expect(h.store.session('s1')?.provider).toBe('codex');
    h.act({ type: 'ticket', sessionId: 's1', source: 'github', sourceKey: '1', ref: '#1', repo: '', title: 'Issue', url: 'https://github.com/acme/widgets/issues/1', playbook: 'dev:review' });
    h.act({ type: 'report', sessionId: 's1', report: { kind: 'approval', prompt: 'Publish', summary: 'Ready', report: null } });
    h.act({ type: 'marker', sessionId: 's1', state: 'idle', detail: null });
    expect(h.item(1)).toMatchObject({ playbook: 'dev:review', provider: 'codex' });
    expect(h.act({ type: 'approve', workItemId: 1 })).toMatchObject([
      { type: 'stop-session', sessionId: 's1', provider: 'codex' },
      { type: 'start-session', sessionId: 's2', provider: 'claude', permissionMode: 'acceptEdits', model: 'claude-sonnet-5' },
    ]);
    h.store.close();
  });

  it('keeps an explicit provider while waiting for a free slot', () => {
    const h = new Harness({ settings: settings({ sessions: { provider: 'codex', codeMode: true, concurrency: 1 } }) });
    const first = h.act({ type: 'new-session', repoRoot: 'D:/folder', provider: 'claude' })[0];
    h.started(first);
    h.act({ type: 'marker', sessionId: 's1', state: 'running', detail: null });
    expect(h.act({ type: 'adhoc', prompt: 'Wait', repoRoot: 'D:/folder', start: true, provider: 'claude' })).toEqual([]);
    expect(h.item(2)).toMatchObject({ status: 'queued', provider: 'claude' });
    expect(h.act({ type: 'marker', sessionId: 's1', state: 'idle', detail: null })).toMatchObject([{ type: 'start-session', provider: 'claude' }]);
    h.store.close();
  });
});
