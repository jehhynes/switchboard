import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { NEEDS_CODE_MODE, NEW_CONVERSATION_TITLE } from '../src/flow.js';
import { heldSlots } from '../src/queue.js';
import { Harness, settings } from './flowHarness.js';

const HOST = 'C:/Users/me/.switchboard/windows/GH-7-widgets-655280.code-workspace';

function only<T extends FlowAction['type']>(actions: FlowAction[], type: T): Extract<FlowAction, { type: T }> {
  expect(actions.map((action) => action.type)).toEqual([type]);

  return actions[0] as Extract<FlowAction, { type: T }>;
}

/** A hosted conversation started and its start confirmed, as the hub does for the view's plus button. */
function conversation(h: Harness): string {
  const start = only(h.act({ type: 'new-conversation', hostWindow: HOST, folder: 'D:/git/support' }), 'start-session');

  h.act({ type: 'session-started', sessionId: start.sessionId, nativeSessionId: start.nativeSessionId!, shortId: 'abcd1234', launchId: start.launchId! });

  return start.sessionId;
}

describe('hosted conversations (architecture.md § Hosted conversations)', () => {
  it('makes an ad hoc work item hosted by the window and starts its Code Mode session at once with no prompt, without waiting for a slot', () => {
    const h = new Harness({ settings: settings({ sessions: { codeMode: true, provider: 'codex', concurrency: 1 } }) });

    h.act({ type: 'adhoc', prompt: 'Busy work', repoRoot: 'D:/scratch', start: true });
    expect(heldSlots(h.store)).toBe(1);

    const start = only(h.act({ type: 'new-conversation', hostWindow: 'C:\\Users\\me\\.switchboard\\windows\\GH-7-widgets-655280.code-workspace', folder: 'D:/git/support' }), 'start-session');

    expect(start).toMatchObject({ kind: 'task', provider: 'claude', cwd: 'D:/git/support', prompt: '', codeMode: true, nativeSessionId: 'uuid-1', launchId: 'uuid-2' });
    expect(start.contract).not.toContain(' done ');
    expect(start.contract).not.toContain(' approval ');
    expect(h.store.ticket(h.item(2).ticketId)).toMatchObject({ source: 'adhoc', title: NEW_CONVERSATION_TITLE, repoRoot: 'D:/git/support', hostWindow: 'C:\\Users\\me\\.switchboard\\windows\\GH-7-widgets-655280.code-workspace' });
    // The host link is compared by windowFileKey, so another spelling of the file finds it.
    expect(h.store.hostedWorkItems(HOST).map((item) => item.id)).toEqual([2]);
    expect(h.store.hostedWorkItems('C:/Users/me/.switchboard/windows/GH-8-widgets-655280.code-workspace')).toEqual([]);
    expect(h.item(2)).toMatchObject({ status: 'running', taskPrompt: null });
    expect(h.store.session(start.sessionId)).toMatchObject({ promptless: true, codeMode: true, reports: ['stage', 'worktree', 'link', 'paste', 'task'] });
  });

  it('refuses a conversation while Code Mode or hooks are off', () => {
    expect(new Harness().send({ type: 'new-conversation', hostWindow: HOST, folder: 'D:/git/support' }).refused).toBe(NEEDS_CODE_MODE);
    expect(new Harness({ settings: settings({ sessions: { codeMode: true, installHooks: false } }) }).send({ type: 'new-conversation', hostWindow: HOST, folder: 'D:/git/support' }).refused).toBe(
      'Code Mode sessions need sessions.installHooks.',
    );
  });

  it('comes up idle, holds a slot only during a turn, and stays open when a turn or its session ends', () => {
    const h = new Harness({ settings: settings({ sessions: { codeMode: true } }) });
    const sessionId = conversation(h);

    expect(h.store.session(sessionId)).toMatchObject({ state: 'idle' });
    expect(heldSlots(h.store)).toBe(0);

    h.act({ type: 'marker', sessionId, state: 'running', detail: null });
    expect(heldSlots(h.store)).toBe(1);

    h.act({ type: 'marker', sessionId, state: 'idle', detail: null });
    expect(h.item(1)).toMatchObject({ status: 'running', error: null });
    expect(heldSlots(h.store)).toBe(0);

    h.act({ type: 'roster', sessions: [], checked: [sessionId] } as never);
    expect(h.store.session(sessionId)?.state).toBe('ended');
    expect(h.item(1)).toMatchObject({ status: 'running', error: null });
  });

  it('titles the conversation by its first message only', () => {
    const h = new Harness({ settings: settings({ sessions: { codeMode: true } }) });

    conversation(h);
    h.act({ type: 'conversation-title', workItemId: 1, text: '\n  Why does the build fail?\nIt says…' });
    h.act({ type: 'conversation-title', workItemId: 1, text: 'Second message' });
    expect(h.store.ticket(h.item(1).ticketId)?.title).toBe('Why does the build fail?');

    const other = new Harness();

    other.act({ type: 'adhoc', prompt: 'New session', repoRoot: 'D:/scratch' });
    other.act({ type: 'conversation-title', workItemId: 1, text: 'Renamed' });
    expect(other.store.ticket(other.item(1).ticketId)?.title).toBe('New session');
  });
});
