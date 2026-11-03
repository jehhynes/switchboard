import { describe, expect, it } from 'vitest';
import type { FlowEvent } from '../src/flow.js';
import { MESSAGES, RESUME_PROMPT } from '../src/flow.js';
import { Harness, MINUTE, issue, settings } from './flowHarness.js';

const NATIVE = '0f1e2d3c-0000-4000-8000-000000000001';
const SHORT = '0f1e2d3c';
const PID = 4242;

/** A work item whose session the operator resumed in a Claude tab after its release, and which runs a turn there. */
function inTab(h: Harness): { item: number; session: string } {
  const [triage] = h.poll(issue('1'));
  h.triaged(triage, 'dev:question');
  const start = h.act({ type: 'start', workItemId: 1 })[0];

  if (start?.type !== 'start-session') {
    throw new Error('Expected a start');
  }

  h.act({ type: 'session-started', sessionId: start.sessionId, nativeSessionId: NATIVE, shortId: SHORT });
  h.act({ type: 'marker', sessionId: start.sessionId, state: 'idle', detail: null });
  h.act({ type: 'stop-succeeded', sessionId: start.sessionId, reason: 'release', shortId: SHORT });
  h.act({ type: 'roster', sessions: [{ sessionId: start.sessionId, state: 'running', detail: null, interactive: true }] });

  return { item: 1, session: start.sessionId };
}

const background = (session: string, patch: { nativeSessionId?: string; workItemIds?: number[]; busy?: boolean } = {}): Extract<FlowEvent, { type: 'background' }> => ({
  type: 'background',
  sessionId: session,
  nativeSessionId: NATIVE,
  pid: PID,
  busy: false,
  workItemIds: [1],
  ...patch,
});

/** Sends the background request and returns its move's ID. */
function moving(h: Harness, session: string): string {
  const [action] = h.act(background(session));

  if (action?.type !== 'resume-session') {
    throw new Error('Expected a resume');
  }

  return action.moveId;
}

describe('Continue in Background (PRD R89)', () => {
  it('moves a running tab session: waits for its tab process, then resumes it in the background, which R39 releases again', () => {
    const h = new Harness();
    const { item, session } = inTab(h);

    expect(h.store.session(session)).toMatchObject({ released: true, state: 'running' });
    expect(h.item(item).status).toBe('running');

    const actions = h.act(background(session));
    const moveId = h.store.session(session)!.move!.id;

    expect(actions).toEqual([{ type: 'resume-session', sessionId: session, moveId, provider: 'claude', nativeSessionId: NATIVE, cwd: h.store.session(session)!.cwd, pid: PID, prompt: RESUME_PROMPT }]);
    expect(h.store.session(session)!.move).toEqual({ id: moveId, pid: PID, phase: 'waiting', at: h.now, deadline: null });

    h.act({ type: 'move-launching', sessionId: session, moveId, deadline: h.now + MINUTE });
    expect(h.store.session(session)!.move).toMatchObject({ phase: 'launching', deadline: h.now + MINUTE });

    h.now += 5_000;
    h.act({ type: 'session-resumed', sessionId: session, moveId, shortId: SHORT });
    expect(h.store.session(session)).toMatchObject({ move: null, movedAt: h.now, shortId: SHORT, state: 'running', released: false, releasing: false, endedAt: null });
    expect(h.item(item).status).toBe('running');

    // Back in its background process, the turn end releases it (PRD R39).
    expect(h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'idle', detail: null, interactive: false }] })).toEqual([
      { type: 'stop-session', sessionId: session, provider: 'claude', shortId: SHORT, reason: 'release' },
    ]);
  });

  it('refuses a session that is not running in its tab, not the window’s, or not Switchboard’s background session', () => {
    const h = new Harness();
    const { session } = inTab(h);

    expect(h.send(background(session, { workItemIds: [2] })).refused).toBe("This tab's session is not one of Switchboard's work items.");
    expect(h.send(background(session, { nativeSessionId: 'other' })).refused).toBe("This tab's session is not one of Switchboard's work items.");
    expect(h.send(background('unknown')).refused).toBe("This tab's session is not one of Switchboard's work items.");

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.send(background(session)).refused).toBe('Continue in Background works while the session is running.');
    h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null });
    expect(h.send(background(session)).refused).toBe('Continue in Background works while the session is running.');

    // An idle state the roster read has not caught up with: the tab's process is busy (review round 1, goal-1).
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.send(background(session, { busy: true })).refused).toBeNull();
    h.store.updateSession(session, { move: null });

    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    h.store.updateSession(session, { pendingFork: 'aaaaaaaa' });
    expect(h.send(background(session)).refused).toBe('Fork aaaaaaaa waits to continue this session; continue in the fork.');

    h.store.updateSession(session, { pendingFork: null, external: true });
    expect(h.send(background(session)).refused).toBe('This session never ran in the background, so it cannot continue there.');
    h.store.updateSession(session, { external: false, provider: 'codex' });
    expect(h.send(background(session)).refused).toBe('This session never ran in the background, so it cannot continue there.');

    h.store.updateSession(session, { provider: 'claude', released: false });
    expect(h.send(background(session)).refused).toBe('The session already runs in the background.');
    h.store.updateSession(session, { released: true, releasing: true });
    expect(h.send(background(session)).refused).toBe('The session already runs in the background.');

    h.store.updateSession(session, { releasing: false });
    moving(h, session);
    expect(h.send(background(session)).refused).toBe('The session is already moving to the background.');
    expect(h.store.session(session)!.move).not.toBeNull();
  });

  it('ignores roster entries, a missing entry, markers and forks while moving, so the work item keeps running and its slot', () => {
    const h = new Harness();
    const { item, session } = inTab(h);

    moving(h, session);

    // The tab's process is gone from the roster before it exits (mechanics M55).
    expect(h.act({ type: 'roster', sessions: [] })).toEqual([]);
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'idle', detail: null, interactive: true }] });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'roster', sessions: [], forks: [{ sessionId: session, nativeSessionId: '9e8d7c6b-0000-4000-8000-000000000002', shortId: '9e8d7c6b', state: 'running', detail: null }] });

    expect(h.store.session(session)).toMatchObject({ state: 'running', nativeSessionId: NATIVE, pendingFork: null, retiredIds: [], endedAt: null });
    expect(h.item(item)).toMatchObject({ status: 'running', error: null });
  });

  it('records an approval report while moving', () => {
    const h = new Harness();
    const { item, session } = inTab(h);

    moving(h, session);
    expect(h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Publish it', report: null }).refused).toBeNull();
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', approvalPrompt: '/publish' });
  });

  it('ends the session with the cause when the resume fails, and ignores results of another attempt', () => {
    const h = new Harness();
    const { item, session } = inTab(h);
    const moveId = moving(h, session);

    h.act({ type: 'session-resumed', sessionId: session, moveId: 'old', shortId: 'ffffffff' });
    h.act({ type: 'resume-failed', sessionId: session, moveId: 'old', message: 'no' });
    h.act({ type: 'move-cancelled', sessionId: session, moveId: 'old' });
    expect(h.store.session(session)!.move?.id).toBe(moveId);

    h.act({ type: 'resume-failed', sessionId: session, moveId, message: 'Claude started a copy as 4df6b678.' });
    expect(h.store.session(session)).toMatchObject({ move: null, movedAt: h.now, state: 'ended', outcome: 'failed', outcomeDetail: 'Continue in Background failed: Claude started a copy as 4df6b678.' });
    expect(h.item(item)).toMatchObject({ status: 'blocked', error: 'Continue in Background failed: Claude started a copy as 4df6b678.' });

    // A late success of the failed attempt changes nothing.
    h.act({ type: 'session-resumed', sessionId: session, moveId, shortId: SHORT });
    expect(h.store.session(session)).toMatchObject({ state: 'ended', released: true });
  });

  it('leaves the session in its tab when its process did not exit', () => {
    const h = new Harness();
    const { item, session } = inTab(h);
    const moveId = moving(h, session);

    h.act({ type: 'move-cancelled', sessionId: session, moveId });
    expect(h.store.session(session)).toMatchObject({ move: null, movedAt: h.now, state: 'running', released: true });

    // The roster observes it again; closing the tab later ends it as before.
    h.act({ type: 'roster', sessions: [] });
    expect(h.store.session(session)!.state).toBe('ended');
    expect(h.item(item).status).toBe('blocked');
  });

  it('stops a session waiting for its tab process as R40 does, and refuses Stop while it launches', () => {
    const h = new Harness();
    const { item, session } = inTab(h);
    const moveId = moving(h, session);

    h.act({ type: 'move-launching', sessionId: session, moveId, deadline: h.now + MINUTE });
    expect(h.send({ type: 'stop', workItemId: item }).refused).toBe('The session is starting in the background; stop it once it has started.');

    const other = new Harness();
    const tab = inTab(other);
    moving(other, tab.session);

    expect(other.act({ type: 'stop', workItemId: tab.item })).toEqual([]);
    expect(other.store.session(tab.session)).toMatchObject({ move: null, state: 'ended', outcome: 'stopped', outcomeDetail: MESSAGES.stopped });
    expect(other.item(tab.item)).toMatchObject({ status: 'blocked', error: MESSAGES.stopped });
  });

  it('returns a held approval when Stop ends a move', () => {
    const h = new Harness();
    const { item, session } = inTab(h);

    // The operator gave the session more work after its approval report (PRD R34).
    h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Publish it', report: null });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'running', approvalHeld: true });

    moving(h, session);
    h.act({ type: 'stop', workItemId: item });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', approvalPrompt: '/publish', error: MESSAGES.stopped });
  });

  it('deletes a moving work item without a stop, so the runner finds no session to launch', () => {
    const h = new Harness();
    const { item, session } = inTab(h);

    moving(h, session);
    expect(h.act({ type: 'delete', workItemId: item })).toEqual([]);
    expect(h.store.session(session)).toBeNull();
  });

  it('keeps the work item’s slot while moving, so a queued work item waits', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const { session } = inTab(h);

    moving(h, session);
    const [triage] = h.poll(issue('1'), issue('2'));
    h.triaged(triage, 'dev:question');
    expect(h.send({ type: 'start', workItemId: 2 }).refused).toBeNull();
    expect(h.item(2).status).toBe('queued');

    h.act({ type: 'roster', sessions: [] });
    expect(h.item(2).status).toBe('queued');
  });

  it('gives each attempt its own ID, and ignores a launch result of an earlier one', () => {
    const h = new Harness();
    const { session } = inTab(h);
    const first = moving(h, session);

    h.act({ type: 'move-cancelled', sessionId: session, moveId: first });
    const second = moving(h, session);

    expect(second).not.toBe(first);
    h.act({ type: 'move-launching', sessionId: session, moveId: first, deadline: h.now + MINUTE });
    expect(h.store.session(session)!.move).toMatchObject({ id: second, phase: 'waiting', deadline: null });
  });

  it('refuses a session that is not its work item’s latest, and one whose turn failed', () => {
    const h = new Harness();
    const { session } = inTab(h);

    h.act({ type: 'marker', sessionId: session, state: 'failed', detail: 'api_error' });
    expect(h.send(background(session)).refused).toBe('Continue in Background works while the session is running.');

    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    h.store.insertSession({ ...h.store.session(session)!, id: 'later', startedAt: h.now + MINUTE, nativeSessionId: 'later-native' });
    expect(h.send(background(session)).refused).toBe("This tab's session is not one of Switchboard's work items.");
  });

  it('logs the request and its result in History, without the move’s bookkeeping', () => {
    const h = new Harness();
    const { session } = inTab(h);
    const moveId = moving(h, session);

    h.act({ type: 'move-launching', sessionId: session, moveId, deadline: h.now + MINUTE });
    h.act({ type: 'session-resumed', sessionId: session, moveId, shortId: SHORT });

    const events = h.store.ticketHistory(1)!.events.slice(-2);

    expect(events.map((event) => `${event.type}/${event.actor}`)).toEqual(['background/operator', 'session-resumed/hub']);
    expect(events[1]!.detail).toEqual({ shortId: SHORT });
    expect(events.flatMap((event) => event.changes.flatMap((change) => Object.keys(change.fields)))).not.toContain('move');
    expect(events[1]!.changes[0]!.fields).toMatchObject({ released: [true, false] });
  });

  it('keeps an approval reported during the move when the resume fails, with the cause', () => {
    const h = new Harness();
    const { item, session } = inTab(h);
    const moveId = moving(h, session);

    h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Publish it', report: null });
    h.act({ type: 'resume-failed', sessionId: session, moveId, message: 'boom' });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', approvalPrompt: '/publish', error: 'Continue in Background failed: boom' });
  });

  it('settles a moved setup session whose resume failed as a setup session that ended', () => {
    const h = new Harness();
    const { item, session } = inTab(h);

    h.store.updateSession(session, { kind: 'setup' });
    h.store.updateWorkItem(item, { status: 'setup' });
    const moveId = moving(h, session);

    h.act({ type: 'resume-failed', sessionId: session, moveId, message: 'boom' });
    expect(h.item(item)).toMatchObject({ status: 'failed', error: MESSAGES.setupWithoutWorktree });
    expect(h.store.session(session)).toMatchObject({ state: 'ended', outcomeDetail: 'Continue in Background failed: boom' });
  });
});
