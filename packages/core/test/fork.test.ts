import { describe, expect, it } from 'vitest';
import type { ObservedFork } from '../src/flow.js';
import { MESSAGES } from '../src/flow.js';
import { Harness, MINUTE } from './flowHarness.js';

const ORIGINAL = '0f1e2d3c-0000-4000-8000-000000000001';
const FORK = { nativeSessionId: '9e8d7c6b-0000-4000-8000-000000000002', shortId: '9e8d7c6b' };

/** A registered session in the operator's own window (PRD R81), the one kind of session Switchboard follows forks of through the roster. */
function registered(h: Harness): { item: number; session: string } {
  h.act({ type: 'register', nativeSessionId: ORIGINAL, shortId: ORIGINAL.slice(0, 8), cwd: 'D:/git/widgets', title: 'Fix the dock' });

  const session = h.store.sessionByNativeId(ORIGINAL)!;

  return { item: session.workItemId, session: session.id };
}

const fork = (session: string, patch: Partial<ObservedFork> = {}): ObservedFork => ({ sessionId: session, ...FORK, state: 'running', detail: null, ...patch });

describe('forks (PRD R78)', () => {
  it("continues a registered session as its fork, retiring the copy it replaced", () => {
    const h = new Harness();
    const { item, session } = registered(h);

    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'idle', detail: null, interactive: true }] });
    expect(h.act({ type: 'roster', sessions: [], forks: [fork(session)] })).toEqual([]);
    expect(h.store.session(session)).toMatchObject({ ...FORK, retiredIds: [ORIGINAL], pendingFork: null, external: true, state: 'running', released: true, endedAt: null });
    expect(h.store.sessionByNativeId(FORK.nativeSessionId)?.id).toBe(session);
    expect(h.item(item)).toMatchObject({ status: 'running', error: null });

    // Later reads keep the fork, which the runner lists by its own short ID now.
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'idle', detail: null, interactive: true }] });
    expect(h.store.session(session)).toMatchObject({ ...FORK, retiredIds: [ORIGINAL], state: 'idle' });
  });

  it('ignores a fork of a retired copy, and of a session that is not its work item’s latest', () => {
    const h = new Harness();
    const { session } = registered(h);

    h.act({ type: 'roster', sessions: [], forks: [fork(session)] });
    h.act({ type: 'roster', sessions: [], forks: [fork(session, { nativeSessionId: ORIGINAL, shortId: ORIGINAL.slice(0, 8) })] });
    expect(h.store.session(session)).toMatchObject({ ...FORK, retiredIds: [ORIGINAL] });

    const later = { ...h.store.session(session)!, id: 'later', startedAt: h.now + MINUTE, state: 'starting' as const, nativeSessionId: null, shortId: null, retiredIds: [] };
    h.store.insertSession(later);
    h.act({ type: 'roster', sessions: [], forks: [fork(session, { nativeSessionId: 'aaaaaaaa-0000-4000-8000-000000000003', shortId: 'aaaaaaaa' })] });
    expect(h.store.session(session)).toMatchObject({ ...FORK, retiredIds: [ORIGINAL] });

    h.store.updateSession('later', { state: 'ended', provider: 'codex', nativeSessionId: 'thread', shortId: 'thread' });
    h.act({ type: 'roster', sessions: [], forks: [fork(session, { nativeSessionId: 'aaaaaaaa-0000-4000-8000-000000000003', shortId: 'aaaaaaaa' })] });
    expect(h.store.session(session)).toMatchObject({ ...FORK, retiredIds: [ORIGINAL] });
  });

  it('ignores a stop result for the copy a fork retired', () => {
    const h = new Harness();
    const { item, session } = registered(h);

    h.act({ type: 'roster', sessions: [], forks: [fork(session)] });

    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator', shortId: ORIGINAL.slice(0, 8) });
    h.act({ type: 'stop-failed', sessionId: session, reason: 'operator', message: 'gone', shortId: ORIGINAL.slice(0, 8) });
    expect(h.store.session(session)).toMatchObject({ ...FORK, state: 'running', outcome: null });
    expect(h.item(item)).toMatchObject({ status: 'running', error: null });

    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator', shortId: FORK.shortId });
    expect(h.item(item)).toMatchObject({ status: 'blocked', error: MESSAGES.stopped });
  });
});
