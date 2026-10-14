import { describe, expect, it } from 'vitest';
import type { ObservedFork } from '../src/flow.js';
import { MESSAGES } from '../src/flow.js';
import { Harness, MINUTE, issue } from './flowHarness.js';

const ORIGINAL = '0f1e2d3c-0000-4000-8000-000000000001';
const FORK = { nativeSessionId: '9e8d7c6b-0000-4000-8000-000000000002', shortId: '9e8d7c6b' };

/** A work item whose session started with a native ID, as Claude's do. */
function running(h: Harness): { item: number; session: string } {
  const [triage] = h.poll(issue('1'));
  h.triaged(triage, 'dev:question');
  const start = h.act({ type: 'start', workItemId: 1 })[0];

  if (start?.type !== 'start-session') {
    throw new Error('Expected a start');
  }

  h.act({ type: 'session-started', sessionId: start.sessionId, nativeSessionId: ORIGINAL, shortId: ORIGINAL.slice(0, 8) });

  return { item: 1, session: start.sessionId };
}

/** The session's turn ended and its background process was released. */
function released(h: Harness, session: string): void {
  h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
  h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release', shortId: ORIGINAL.slice(0, 8) });
}

const fork = (session: string, patch: Partial<ObservedFork> = {}): ObservedFork => ({ sessionId: session, ...FORK, state: 'running', detail: null, ...patch });

describe('forks (PRD R78)', () => {
  it('continues a released session as its fork, retiring the copy it replaced', () => {
    const h = new Harness();
    const { item, session } = running(h);

    released(h, session);
    expect(h.item(item).status).toBe('blocked');

    expect(h.act({ type: 'roster', sessions: [], forks: [fork(session)] })).toEqual([]);
    expect(h.store.session(session)).toMatchObject({ ...FORK, retiredIds: [ORIGINAL], pendingFork: null, external: false, state: 'running', released: true, endedAt: null });
    expect(h.store.sessionByNativeId(FORK.nativeSessionId)?.id).toBe(session);
    expect(h.item(item)).toMatchObject({ status: 'running', error: null });

    // Later reads keep the fork, which the runner lists by its own short ID now.
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'idle', detail: null, interactive: true }] });
    expect(h.store.session(session)).toMatchObject({ ...FORK, retiredIds: [ORIGINAL], state: 'idle' });
  });

  it('ignores a fork of a retired copy, and of a session that is not its work item’s latest', () => {
    const h = new Harness();
    const { session } = running(h);

    released(h, session);
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

  it('waits while the copy holds the background process, which is still observed, and adopts the fork once it is released', () => {
    const h = new Harness();
    const { item, session } = running(h);

    // The original still runs in its background process; its own turn end comes from the roster, as with hooks off.
    const actions = h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'idle', detail: null, interactive: false }], forks: [fork(session)] });
    expect(actions).toEqual([{ type: 'stop-session', sessionId: session, provider: 'claude', shortId: ORIGINAL.slice(0, 8), reason: 'release' }]);
    expect(h.store.session(session)).toMatchObject({ nativeSessionId: ORIGINAL, pendingFork: FORK.shortId, state: 'idle', retiredIds: [] });
    expect(h.item(item).status).toBe('blocked');

    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release', shortId: ORIGINAL.slice(0, 8) });
    h.act({ type: 'roster', sessions: [], forks: [fork(session)] });
    expect(h.store.session(session)).toMatchObject({ ...FORK, pendingFork: null, external: false, retiredIds: [ORIGINAL], state: 'running' });
    expect(h.item(item).status).toBe('running');
  });

  it('refuses Open in Claude while a fork waits for a copy waiting on a question, and continues in the fork after Stop', () => {
    const h = new Harness();
    const { item, session } = running(h);

    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: null, interactive: false }], forks: [fork(session)] });
    expect(h.store.session(session)).toMatchObject({ state: 'waiting', pendingFork: FORK.shortId });
    expect(h.send({ type: 'open-question', workItemId: item, nativeSessionId: ORIGINAL }).refused).toBe(`Fork ${FORK.shortId} waits to continue this session; stop the session to continue in the fork.`);

    h.act({ type: 'stop', workItemId: item });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator', shortId: ORIGINAL.slice(0, 8) });
    h.act({ type: 'roster', sessions: [], forks: [fork(session)] });
    expect(h.store.session(session)).toMatchObject({ ...FORK, state: 'running', pendingFork: null, external: false });
    expect(h.item(item).status).toBe('running');
  });

  it('clears a waiting fork that a later read that looked for the session no longer lists', () => {
    const h = new Harness();
    const { session } = running(h);

    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: null }], forks: [fork(session)] });
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: null }], checked: [] });
    expect(h.store.session(session)?.pendingFork).toBe(FORK.shortId);
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: null }], checked: [session] });
    expect(h.store.session(session)).toMatchObject({ pendingFork: null, external: false, nativeSessionId: ORIGINAL });
  });

  it('ends a held copy that exits while its fork waits', () => {
    const h = new Harness();
    const { session } = running(h);

    h.act({ type: 'roster', sessions: [], forks: [fork(session)] });
    expect(h.store.session(session)).toMatchObject({ nativeSessionId: ORIGINAL, pendingFork: FORK.shortId, state: 'ended', released: true });

    h.act({ type: 'roster', sessions: [], forks: [fork(session)] });
    expect(h.store.session(session)).toMatchObject({ ...FORK, state: 'running' });
  });

  it('ignores a stop result for the copy a fork retired', () => {
    const h = new Harness();
    const { item, session } = running(h);

    released(h, session);
    h.act({ type: 'roster', sessions: [], forks: [fork(session)] });

    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator', shortId: ORIGINAL.slice(0, 8) });
    h.act({ type: 'stop-failed', sessionId: session, reason: 'operator', message: 'gone', shortId: ORIGINAL.slice(0, 8) });
    expect(h.store.session(session)).toMatchObject({ ...FORK, state: 'running', outcome: null });
    expect(h.item(item)).toMatchObject({ status: 'running', error: null });

    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator', shortId: FORK.shortId });
    expect(h.item(item)).toMatchObject({ status: 'blocked', error: MESSAGES.stopped });
  });

  it('keeps an opened question waiting until the fork runs', () => {
    const h = new Harness();
    const { item, session } = running(h);

    h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null });
    h.act({ type: 'open-question', workItemId: item, nativeSessionId: ORIGINAL });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'open', shortId: ORIGINAL.slice(0, 8) });
    expect(h.store.session(session)).toMatchObject({ outcome: 'opened', state: 'ended' });

    h.act({ type: 'roster', sessions: [], forks: [fork(session, { state: 'idle' })] });
    expect(h.store.session(session)).toMatchObject({ ...FORK, outcome: 'opened', state: 'ended' });

    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'running', detail: null, interactive: true }] });
    expect(h.store.session(session)).toMatchObject({ outcome: null, state: 'running' });
  });
});
