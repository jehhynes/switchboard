import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { heldSlots } from '../src/queue.js';
import { Harness, settings } from './flowHarness.js';

function start(h: Harness, provider: 'claude' | 'codex' = 'codex', model: string | null = null) {
  const actions = h.act({ type: 'new-session', repoRoot: 'D:/git/switchboard', provider, model });
  expect(actions).toHaveLength(1);
  return actions[0] as Extract<FlowAction, { type: 'start-session' }>;
}

describe('standalone interactive sessions', () => {
  it('starts empty in its own work item with the chosen provider and model', () => {
    const h = new Harness();
    const action = start(h, 'codex', 'gpt-6.2-sol');
    const item = h.item(1);

    expect(action).toMatchObject({ provider: 'codex', model: 'gpt-6.2-sol', cwd: 'D:/git/switchboard', prompt: '' });
    expect(action.contract).not.toContain(' done ');
    expect(item).toMatchObject({ interactive: true, status: 'running', taskPrompt: null, model: 'gpt-6.2-sol' });
    expect(h.store.ticket(item.ticketId)).toMatchObject({ title: 'New session', hostWindow: null });
    expect(h.store.session(action.sessionId)).toMatchObject({ promptless: true });
  });

  it('refuses Claude without Code Mode or hooks before creating an item', () => {
    const h = new Harness();
    expect(h.send({ type: 'new-session', repoRoot: 'D:/git/switchboard', provider: 'claude' }).refused).toContain('Code Mode');
    expect(h.store.workItemsWithStatus('running')).toHaveLength(0);
    const hooks = new Harness({ settings: settings({ sessions: { codeMode: true, installHooks: false } }) });
    expect(hooks.send({ type: 'new-session', repoRoot: 'D:/git/switchboard', provider: 'claude' }).refused).toContain('installHooks');
  });

  it('stays in progress while idle and after the process ends, releasing its slot', () => {
    const h = new Harness();
    const action = start(h);
    h.act({ type: 'session-started', sessionId: action.sessionId, nativeSessionId: 'thread-1', shortId: 'thread-1' });
    expect(heldSlots(h.store)).toBe(0);
    h.act({ type: 'marker', sessionId: action.sessionId, state: 'running', detail: null });
    expect(heldSlots(h.store)).toBe(1);
    h.act({ type: 'marker', sessionId: action.sessionId, state: 'idle', detail: null });
    expect(h.item(1).status).toBe('running');
    expect(heldSlots(h.store)).toBe(0);
    h.act({ type: 'roster', sessions: [], checked: [action.sessionId] } as never);
    expect(h.item(1).status).toBe('running');
  });

  it('retries an empty start with its model and reopens after Mark done', () => {
    const h = new Harness();
    const first = start(h, 'codex', 'gpt-6.2-sol');
    h.act({ type: 'session-start-failed', sessionId: first.sessionId, message: 'Daemon unavailable' });
    expect(h.item(1).status).toBe('failed');
    const second = h.act({ type: 'retry', workItemId: 1 })[0] as Extract<FlowAction, { type: 'start-session' }>;
    expect(second).toMatchObject({ provider: 'codex', model: 'gpt-6.2-sol', prompt: '' });
    h.act({ type: 'mark-done', workItemId: 1 });
    expect(h.item(1).status).toBe('done');
    h.act({ type: 'reopen', workItemId: 1 });
    expect(h.item(1).status).toBe('running');
  });

  it('deletes its work item while retaining the ticket history', () => {
    const h = new Harness();
    const action = start(h);
    h.act({ type: 'session-started', sessionId: action.sessionId, nativeSessionId: 'thread-1', shortId: 'thread-1' });
    h.act({ type: 'mark-done', workItemId: 1 });
    h.act({ type: 'delete', workItemId: 1 });
    expect(h.store.workItem(1)).toBeNull();
    expect(h.store.ticket(1)?.source).toBe('adhoc');
  });
});
