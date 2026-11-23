import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { NEEDS_HOOKS, NEW_CONVERSATION_TITLE } from '../src/flow.js';
import { heldSlots } from '../src/queue.js';
import { hostKey } from '../src/conversation.js';
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
    const h = new Harness({ settings: settings({ sessions: { codeMode: true, provider: 'claude', concurrency: 1 } }) });

    h.act({ type: 'adhoc', prompt: 'Busy work', repoRoot: 'D:/scratch', start: true });
    expect(heldSlots(h.store)).toBe(1);

    const start = only(h.act({ type: 'new-conversation', hostWindow: 'C:\\Users\\me\\.switchboard\\windows\\GH-7-widgets-655280.code-workspace', folder: 'D:/git/support' }), 'start-session');

    expect(start).toMatchObject({ kind: 'task', provider: 'claude', cwd: 'D:/git/support', prompt: '', codeMode: true, nativeSessionId: 'uuid-3', launchId: 'uuid-4' });
    expect(start.contract).not.toContain(' done ');
    expect(start.contract).not.toContain(' approval ');
    expect(h.store.ticket(h.item(2).ticketId)).toMatchObject({ source: 'adhoc', title: NEW_CONVERSATION_TITLE, repoRoot: 'D:/git/support', hostWindow: 'C:\\Users\\me\\.switchboard\\windows\\GH-7-widgets-655280.code-workspace' });
    // The host link is compared by windowFileKey, so another spelling of the file finds it.
    expect(h.store.hostedWorkItems(HOST).map((item) => item.id)).toEqual([2]);
    expect(h.store.hostedWorkItems('C:/Users/me/.switchboard/windows/GH-8-widgets-655280.code-workspace')).toEqual([]);

    // A folder window on a drive root hosts by the root, whose trailing separator both sides drop.
    only(h.act({ type: 'new-conversation', hostWindow: 'D:\\', folder: 'D:\\' }), 'start-session');
    expect(h.store.hostedWorkItems('d:/').map((item) => item.id)).toEqual([3]);
    expect(h.store.hostedWorkItems('D:\\')).toHaveLength(1);

    // A folder whose name has an uppercase letter outside ASCII is found by every spelling of its case, which SQLite's lower() would miss.
    only(h.act({ type: 'new-conversation', hostWindow: 'D:\\git\\Étage', folder: 'D:\\git\\Étage' }), 'start-session');
    expect(h.store.hostedWorkItems('D:\\git\\Étage').map((item) => item.id)).toEqual([4]);
    expect(h.store.hostedWorkItems('d:/git/étage/').map((item) => item.id)).toEqual([4]);
    expect(h.store.hostedWorkItems('D:/git/Etage')).toEqual([]);
    expect(h.item(2)).toMatchObject({ status: 'running', taskPrompt: null });
    expect(h.store.session(start.sessionId)).toMatchObject({ promptless: true, codeMode: true, reports: ['stage', 'worktree', 'link', 'paste', 'task'] });
  });

  it('holds a conversation without Code Mode while it is off, and refuses one while hooks are off', () => {
    expect(new Harness().act({ type: 'new-conversation', hostWindow: HOST, folder: 'D:/git/support' })).toMatchObject([{ type: 'start-session', codeMode: true, withoutCodeMode: true, prompt: '' }]);
    expect(new Harness({ settings: settings({ sessions: { codeMode: true, installHooks: false } }) }).send({ type: 'new-conversation', hostWindow: HOST, folder: 'D:/git/support' }).refused).toBe(NEEDS_HOOKS);
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

  it('summarizes the first message and follows provider titles', () => {
    const h = new Harness({ settings: settings({ sessions: { codeMode: true } }) });

    conversation(h);
    h.act({ type: 'conversation-title', workItemId: 1, text: '\n  Why does the build fail?\nIt says…' });
    h.act({ type: 'conversation-title', workItemId: 1, text: 'Second message' });
    expect(h.store.ticket(h.item(1).ticketId)?.title).toBe('Why does the build fail?');
    h.act({ type: 'conversation-title', workItemId: 1, text: 'switchboard · ad-hoc · adhoc 1', origin: 'provider-manual' });
    expect(h.store.ticket(h.item(1).ticketId)?.title).toBe('Why does the build fail?');
    h.act({ type: 'conversation-title', workItemId: 1, text: 'Build failure in test setup', origin: 'provider-auto' });
    expect(h.store.ticket(h.item(1).ticketId)?.title).toBe('Build failure in test setup');
    h.act({ type: 'conversation-title', workItemId: 1, text: 'Build failure in test setup', origin: 'provider-manual' });
    h.act({ type: 'conversation-title', workItemId: 1, text: 'Unwanted later title', origin: 'provider-auto' });
    expect(h.store.ticket(h.item(1).ticketId)?.title).toBe('Build failure in test setup');
    h.act({ type: 'conversation-title', workItemId: 1, text: 'Test setup fails', origin: 'provider-manual' });
    h.act({ type: 'conversation-title', workItemId: 1, text: 'Later automatic title', origin: 'provider-auto' });
    expect(h.store.ticket(h.item(1).ticketId)?.title).toBe('Test setup fails');

    const other = new Harness();

    other.act({ type: 'adhoc', prompt: 'New session', repoRoot: 'D:/scratch' });
    other.act({ type: 'conversation-title', workItemId: 1, text: 'Renamed' });
    expect(other.store.ticket(other.item(1).ticketId)?.title).toBe('New session');
  });
});

describe('hostKey (architecture.md § Window scope)', () => {
  it('compares item files without case, and folder hosts without case only where the file system has none', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      expect(hostKey('/home/op/.switchboard/windows/GH-7.code-workspace')).toBe('/home/op/.switchboard/windows/gh-7.code-workspace');
      expect(hostKey('/repo/Foo/')).toBe('/repo/Foo');
      expect(hostKey('/repo/Foo')).not.toBe(hostKey('/repo/foo'));
      expect(hostKey('/tmp/a\\b')).not.toBe(hostKey('/tmp/a/b'));
      expect(hostKey('/')).toBe('/');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(hostKey('D:\\git\\Support\\')).toBe('d:/git/support');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
