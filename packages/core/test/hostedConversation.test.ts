import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { heldSlots } from '../src/queue.js';
import { hostKey } from '../src/conversation.js';
import { Harness, settings } from './flowHarness.js';

function only<T extends FlowAction['type']>(actions: FlowAction[], type: T): Extract<FlowAction, { type: T }> {
  expect(actions.map((action) => action.type)).toEqual([type]);

  return actions[0] as Extract<FlowAction, { type: T }>;
}

/** An empty standalone session started and its start confirmed, as the hub does for the page's New session. */
function conversation(h: Harness): string {
  const start = only(h.act({ type: 'new-session', repoRoot: 'D:/git/support' }), 'start-session');

  h.act({ type: 'session-started', sessionId: start.sessionId, nativeSessionId: start.nativeSessionId!, shortId: 'abcd1234', launchId: start.launchId! });

  return start.sessionId;
}

describe('empty standalone sessions (PRD R122)', () => {
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
