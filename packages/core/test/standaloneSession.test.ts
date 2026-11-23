import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { heldSlots } from '../src/queue.js';
import { Harness, settings } from './flowHarness.js';

function start(h: Harness, provider: 'claude' | 'codex' = 'codex', model: string | null = null, prompt?: string) {
  const actions = h.act({ type: 'new-session', repoRoot: 'D:/git/switchboard', provider, model, ...(prompt === undefined ? {} : { prompt }) });
  expect(actions).toHaveLength(1);
  return actions[0] as Extract<FlowAction, { type: 'start-session' }>;
}

function only(actions: FlowAction[]) {
  const starts = actions.filter((action) => action.type === 'start-session');
  expect(starts).toHaveLength(1);
  return starts[0] as Extract<FlowAction, { type: 'start-session' }>;
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

  it('starts with a first message as its first turn, titled from the message until the provider names it', () => {
    const h = new Harness();
    const action = start(h, 'codex', null, '  Please find why the inbox badge counts archived threads. Then fix it.\n');
    const item = h.item(1);

    expect(action).toMatchObject({ provider: 'codex', prompt: 'Please find why the inbox badge counts archived threads. Then fix it.' });
    expect(action.contract).not.toContain(' done ');
    expect(item).toMatchObject({ interactive: true, status: 'running', taskPrompt: 'Please find why the inbox badge counts archived threads. Then fix it.', titleOrigin: 'generated' });
    expect(h.store.ticket(item.ticketId)?.title).toBe('find why the inbox badge counts archived threads');
    expect(h.store.session(action.sessionId)).toMatchObject({ promptless: false });
    // The first send's summary does not replace it; the provider's name does.
    h.act({ type: 'conversation-title', workItemId: 1, text: 'Something else entirely' });
    expect(h.store.ticket(item.ticketId)?.title).toBe('find why the inbox badge counts archived threads');
    h.act({ type: 'conversation-title', workItemId: 1, text: 'Inbox badge fix', origin: 'provider-auto' });
    expect(h.store.ticket(item.ticketId)?.title).toBe('Inbox badge fix');
  });

  it('sends the first message again after a failed start, even one refused after its thread started, and not after a session ran', () => {
    const h = new Harness();
    const first = start(h, 'codex', null, 'Look around');
    h.act({ type: 'session-start-failed', sessionId: first.sessionId, message: 'Daemon unavailable' });
    const second = only(h.act({ type: 'retry', workItemId: 1 }));
    expect(second).toMatchObject({ prompt: 'Look around' });
    // Codex stores the thread before its first turn, which may still be refused.
    h.act({ type: 'session-started', sessionId: second.sessionId, nativeSessionId: 'thread-2', shortId: 'thread-2' });
    h.act({ type: 'session-start-failed', sessionId: second.sessionId, message: 'The first turn was refused.' });
    const third = only(h.act({ type: 'retry', workItemId: 1 }));
    expect(third).toMatchObject({ prompt: 'Look around' });
    expect(h.store.session(third.sessionId)).toMatchObject({ promptless: false });
    // Once a session ran and ended, Retry opens an empty conversation.
    h.act({ type: 'session-started', sessionId: third.sessionId, nativeSessionId: 'thread-3', shortId: 'thread-3' });
    h.store.updateSession(third.sessionId, { state: 'ended', outcome: 'stopped' });
    h.store.updateWorkItem(1, { status: 'failed' });
    const fourth = only(h.act({ type: 'retry', workItemId: 1 }));
    expect(fourth).toMatchObject({ prompt: '' });
    expect(h.store.session(fourth.sessionId)).toMatchObject({ promptless: true });
  });

  it('refuses a blank or overlong model before creating an item', () => {
    const h = new Harness();
    expect(h.send({ type: 'new-session', repoRoot: 'D:/git/switchboard', provider: 'codex', model: ' ' }).refused).toBe('Choose a model name under 200 characters.');
    expect(h.send({ type: 'adhoc', prompt: 'x', repoRoot: 'D:/git/switchboard', provider: 'codex', model: 'm'.repeat(201) }).refused).toBe('Choose a model name under 200 characters.');
    expect(h.store.adhocKeys()).toHaveLength(0);
  });

  it('holds Claude without Code Mode while it is off, and refuses it without hooks before creating an item', () => {
    const h = new Harness();
    expect(h.act({ type: 'new-session', repoRoot: 'D:/git/switchboard', provider: 'claude' })).toMatchObject([{ type: 'start-session', codeMode: true, withoutCodeMode: true }]);
    const hooks = new Harness({ settings: settings({ sessions: { codeMode: true, installHooks: false } }) });
    expect(hooks.send({ type: 'new-session', repoRoot: 'D:/git/switchboard', provider: 'claude' }).refused).toContain('installHooks');
    expect(hooks.store.workItemsWithStatus('running')).toHaveLength(0);
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

  it('keeps a task\'s model through its start and Retry', () => {
    const h = new Harness();
    // Queued, it starts at once while a slot is free.
    const first = only(h.act({ type: 'adhoc', prompt: 'Sweep the logs', repoRoot: 'D:/git/switchboard', start: true, provider: 'codex', model: ' gpt-6.2-sol ' }));
    expect(h.item(1)).toMatchObject({ interactive: false, model: 'gpt-6.2-sol', taskPrompt: 'Sweep the logs' });
    expect(first).toMatchObject({ provider: 'codex', model: 'gpt-6.2-sol', prompt: 'Sweep the logs' });
    expect(first.contract).toContain(' done ');
    h.act({ type: 'session-start-failed', sessionId: first.sessionId, message: 'Daemon unavailable' });
    expect(only(h.act({ type: 'retry', workItemId: 1 }))).toMatchObject({ model: 'gpt-6.2-sol', prompt: 'Sweep the logs' });
    // Waiting for Start, it keeps the model too.
    h.act({ type: 'adhoc', prompt: 'Later', repoRoot: 'D:/git/switchboard', start: false, model: 'opus' });
    expect(h.item(2)).toMatchObject({ status: 'unstarted', model: 'opus' });
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
