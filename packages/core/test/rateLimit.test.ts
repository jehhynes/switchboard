import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { MESSAGES } from '../src/flow.js';
import { markOf } from '../src/group.js';
import { BACKOFF_MS, CLI_MARGIN_MS, CONTINUE_TEXT, givesUp, limitFor, MAX_ATTEMPTS, RESET_MARGIN_MS, TEXT_MARGIN_MS, waitsOnLimit } from '../src/limit.js';
import type { LimitReading } from '../src/model.js';
import { queueWaits } from '../src/queue.js';
import { Harness, HOUR, issue, MINUTE, T0 } from './flowHarness.js';

const RESET = T0 + 2 * HOUR;
const USAGE: LimitReading = { kind: 'usage', window: 'five_hour', resetsAt: RESET, exact: true, cli: true, message: "You've hit your 5-hour limit · resets 2:00pm (America/New_York)" };

function held(h: Harness, action: FlowAction | undefined, launchId = 'launch-1'): string {
  if (action?.type !== 'start-session') {
    throw new Error(`Expected a start-session action, got ${JSON.stringify(action)}`);
  }

  h.store.updateSession(action.sessionId, { codeMode: true });
  h.act({ type: 'session-started', sessionId: action.sessionId, nativeSessionId: `${action.sessionId}-native`, shortId: `${action.sessionId}-short`, launchId });

  return action.sessionId;
}

function heldTask(h: Harness, key = '7'): string {
  const [triage] = h.poll(issue(key));

  h.triaged(triage, 'dev:question');

  return held(h, h.act({ type: 'start', workItemId: h.store.workItemsForTicket(h.store.findTicket('github', key)!.id)[0]!.id })[0]);
}

function heldSetup(h: Harness, key = '15619'): string {
  const [triage] = h.poll(issue(key));

  return held(h, h.triaged(triage, 'dev:develop')[0]);
}

const mark = (h: Harness, id: number) => markOf({ ...h.item(id), sessions: h.store.sessionsFor(id), triage: null, approvalSends: false });

describe('the limit policy (architecture.md § Rate limits)', () => {
  it('waits for the reset plus a margin: longer while Claude Code waits itself, and a minute more for a time read from text', () => {
    expect(limitFor(USAGE, null, 'l', T0).nextAt).toBe(RESET + CLI_MARGIN_MS);
    expect(limitFor({ ...USAGE, cli: false }, null, 'l', T0).nextAt).toBe(RESET + RESET_MARGIN_MS);
    expect(limitFor({ ...USAGE, cli: false, exact: false }, null, 'l', T0).nextAt).toBe(RESET + RESET_MARGIN_MS + TEXT_MARGIN_MS);
    expect(limitFor({ ...USAGE, resetsAt: null }, null, 'l', T0).nextAt).toBe(T0 + BACKOFF_MS[0]!);
    expect(limitFor({ ...USAGE, resetsAt: T0 - HOUR }, null, 'l', T0).nextAt).toBe(T0);
  });

  it('keeps the attempts of the same launch and starts again under another', () => {
    const earlier = { ...limitFor(USAGE, null, 'l', T0), attempts: 2 };

    expect(limitFor(USAGE, earlier, 'l', T0 + HOUR)).toMatchObject({ attempts: 2, since: T0, at: T0 + HOUR });
    expect(limitFor(USAGE, earlier, 'other', T0 + HOUR)).toMatchObject({ attempts: 0, since: T0 + HOUR });
  });

  it('gives up once the last attempt waited with no new turn, or a day and two hours after the first was due', () => {
    const limit = limitFor(USAGE, null, 'l', T0);

    expect(givesUp({ ...limit, attempts: MAX_ATTEMPTS - 1, nextAt: T0 }, T0 + HOUR)).toBe(false);
    expect(givesUp({ ...limit, attempts: MAX_ATTEMPTS, nextAt: T0 + 3 * HOUR }, T0 + 2 * HOUR)).toBe(false);
    expect(givesUp({ ...limit, attempts: MAX_ATTEMPTS, nextAt: T0 + 3 * HOUR }, T0 + 3 * HOUR)).toBe(true);
    expect(givesUp(limit, RESET + CLI_MARGIN_MS + 26 * HOUR)).toBe(false);
    expect(givesUp(limit, RESET + CLI_MARGIN_MS + 26 * HOUR + 1)).toBe(true);
  });

  it("types Claude Code's own continue text", () => {
    expect(CONTINUE_TEXT).toContain('Continue the task you were working on when the limit was reached');
  });
});

describe('a held session at a limit', () => {
  it('keeps its task running, with the limit, the Rate limited mark and no action', () => {
    const h = new Harness();
    const id = heldTask(h);

    expect(h.act({ type: 'marker', sessionId: id, state: 'failed', detail: 'rate_limit', limit: USAGE })).toEqual([]);
    expect(h.store.session(id)).toMatchObject({ state: 'failed', released: false, releasing: false, rateLimit: { resetsAt: RESET, cli: true, attempts: 0, launchId: 'launch-1', nextAt: RESET + CLI_MARGIN_MS } });
    expect(h.item(1)).toMatchObject({ status: 'running', error: null });
    expect(mark(h, 1)).toBe('limited');
    expect(h.store.ticketHistory(1)!.events.at(-1)).toMatchObject({ type: 'marker', detail: { state: 'failed', detail: 'rate_limit', limit: { kind: 'usage', window: 'five_hour', resetsAt: RESET, cli: true } } });
  });

  it('reads a failed rate_limit turn without a reading as a usage limit with no reset time', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'marker', sessionId: id, state: 'failed', detail: 'rate_limit' });
    expect(h.store.session(id)!.rateLimit).toMatchObject({ kind: 'usage', resetsAt: null, nextAt: T0 + BACKOFF_MS[0]! });
    expect(h.item(1).status).toBe('running');
  });

  it('keeps a setup session in setup, never ended at its turn end or by the idle limit, and finishes setup at its next turn end', () => {
    const h = new Harness();
    const setup = heldSetup(h);

    expect(h.act({ type: 'marker', sessionId: setup, state: 'failed', detail: 'rate_limit', limit: USAGE })).toEqual([]);
    expect(h.act({ type: 'held-idle', sessionId: setup })).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'setup', error: null });
    expect(mark(h, 1)).toBe('limited');

    h.report(setup, { kind: 'worktree', path: 'D:/git/widgets-wt/15619', branch: '15619-fix' });
    h.act({ type: 'marker', sessionId: setup, state: 'running', detail: null });
    expect(h.store.session(setup)!.rateLimit).not.toBeNull();
    expect(waitsOnLimit(h.store.session(setup))).toBe(false);

    const actions = h.act({ type: 'marker', sessionId: setup, state: 'idle', detail: null });

    expect(actions).toEqual([expect.objectContaining({ type: 'start-session', kind: 'task' })]);
    expect(h.store.session(setup)!.rateLimit).toBeNull();
  });

  it('does not finish a setup that stopped at a limit with its worktree already linked', () => {
    const h = new Harness();
    const setup = heldSetup(h);

    h.report(setup, { kind: 'worktree', path: 'D:/git/widgets-wt/15619', branch: '15619-fix' });
    expect(h.act({ type: 'marker', sessionId: setup, state: 'idle', detail: null, limit: USAGE })).toEqual([]);
    expect(h.status(1)).toBe('setup');
  });

  it('keeps a task whose turn ended in the grace allowance running instead of blocked', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null, limit: { ...USAGE, resetsAt: null } });
    expect(h.item(1)).toMatchObject({ status: 'running', error: null });
  });

  it('runs a task again when the limit is read after the turn end blocked it', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.turnEndedWithoutApproval });

    h.now += 1000;
    h.act({ type: 'limit-found', sessionId: id, limit: USAGE });
    expect(h.item(1)).toMatchObject({ status: 'running', error: null });
    expect(h.store.session(id)!.rateLimit).toMatchObject({ resetsAt: RESET });

    // A later reading only updates the limit.
    h.act({ type: 'limit-found', sessionId: id, limit: { ...USAGE, resetsAt: RESET + MINUTE } });
    expect(h.store.session(id)!.rateLimit).toMatchObject({ resetsAt: RESET + MINUTE });
  });

  it('ignores a limit read for a session in a turn', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'limit-found', sessionId: id, limit: USAGE });
    expect(h.store.session(id)!.rateLimit ?? null).toBeNull();
  });

  it('counts attempts across a limit hit again, clears the limit when a turn ends without one, and backs off after each attempt', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'marker', sessionId: id, state: 'failed', detail: 'rate_limit', limit: USAGE });
    h.now = RESET + CLI_MARGIN_MS;
    h.act({ type: 'limit-attempt', sessionId: id, error: null });
    expect(h.store.session(id)!.rateLimit).toMatchObject({ attempts: 1, nextAt: h.now + BACKOFF_MS[0]! });
    expect(h.store.ticketHistory(1)!.events.at(-1)).toMatchObject({ type: 'limit-attempt', detail: { attempt: 1 } });

    h.act({ type: 'marker', sessionId: id, state: 'running', detail: null });
    expect(h.item(1).status).toBe('running');
    h.act({ type: 'marker', sessionId: id, state: 'failed', detail: 'rate_limit', limit: { ...USAGE, resetsAt: RESET + HOUR } });
    expect(h.store.session(id)!.rateLimit).toMatchObject({ attempts: 1, resetsAt: RESET + HOUR, since: T0 });

    h.act({ type: 'marker', sessionId: id, state: 'running', detail: null });
    h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    expect(h.store.session(id)!.rateLimit).toBeNull();
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.turnEndedWithoutApproval });
  });

  it('gives up on a tick after the last attempt, blocking the work item with why', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'marker', sessionId: id, state: 'failed', detail: 'rate_limit', limit: USAGE });
    h.store.updateSession(id, { rateLimit: { ...h.store.session(id)!.rateLimit!, attempts: MAX_ATTEMPTS, nextAt: RESET + HOUR } });
    h.now = RESET + HOUR - 1;
    h.act({ type: 'tick' });
    expect(h.item(1).status).toBe('running');

    h.now = RESET + HOUR;
    h.act({ type: 'tick' });
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.limitGaveUp });
    expect(h.store.session(id)!.rateLimit).toBeNull();
  });

  it('leaves the session to the operator when they acted in its terminal, and a resumed setup returns to setup', () => {
    const h = new Harness();
    const setup = heldSetup(h);

    h.act({ type: 'marker', sessionId: setup, state: 'failed', detail: 'rate_limit', limit: USAGE });
    h.act({ type: 'limit-skipped', sessionId: setup, reason: 'input' });
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.limitSkipped });
    expect(h.store.session(setup)!.rateLimit).toBeNull();

    h.act({ type: 'marker', sessionId: setup, state: 'running', detail: null });
    expect(h.item(1)).toMatchObject({ status: 'setup', error: null });
  });

  it('ignores attempts and skips for a session not waiting on a limit', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'limit-attempt', sessionId: id, error: null });
    h.act({ type: 'limit-skipped', sessionId: id, reason: 'input' });
    expect(h.item(1).status).toBe('running');
    expect(h.store.session(id)!.rateLimit ?? null).toBeNull();
  });
});

describe('the end of a wait nothing will continue', () => {
  it('stops waiting when the work item becomes done, so an app-server thread is released as before and a held session can idle out', () => {
    const h = new Harness({ settings: { ...new Harness().settings, sessions: { ...new Harness().settings.sessions, provider: 'codex' } } });
    const action = h.act({ type: 'adhoc', prompt: 'Do work', repoRoot: 'D:/scratch', start: true })[0] as Extract<FlowAction, { type: 'start-session' }>;

    h.act({ type: 'session-started', sessionId: action.sessionId, nativeSessionId: 'thread-1', shortId: 'thread-1' });
    h.act({ type: 'marker', sessionId: action.sessionId, state: 'failed', detail: 'rate_limit', limit: USAGE });
    expect(h.act({ type: 'mark-done', workItemId: 1 })).toEqual([expect.objectContaining({ type: 'stop-session', reason: 'release', execution: 'app-server' })]);
    expect(h.store.session(action.sessionId)?.rateLimit).toBeNull();

    const held = new Harness();
    const id = heldTask(held);

    held.act({ type: 'marker', sessionId: id, state: 'failed', detail: 'rate_limit', limit: USAGE });
    expect(held.act({ type: 'mark-done', workItemId: 1 })).toEqual([]);
    expect(held.store.session(id)?.rateLimit).toBeNull();
    expect(held.act({ type: 'held-idle', sessionId: id })).toEqual([expect.objectContaining({ type: 'stop-session', reason: 'release', codeMode: true })]);
  });
});

describe('a background session at a limit (display only)', () => {
  it('is released and blocks its task with the cause, keeping the limit for the row', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('7'));

    h.triaged(triage, 'dev:question');
    const id = h.started(h.act({ type: 'start', workItemId: 1 })[0]);
    const actions = h.act({ type: 'marker', sessionId: id, state: 'failed', detail: 'rate_limit', limit: USAGE });

    expect(actions).toEqual([expect.objectContaining({ type: 'stop-session', sessionId: id, reason: 'release' })]);
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.turnAtLimit });
    expect(h.store.session(id)!.rateLimit).toMatchObject({ resetsAt: RESET });
  });

  it('fails a setup whose process ended at a limit with a cause that says to retry after the reset', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('15619'));
    const id = h.started(h.triaged(triage, 'dev:develop')[0]);

    h.act({ type: 'marker', sessionId: id, state: 'failed', detail: 'rate_limit', limit: USAGE });
    h.act({ type: 'roster', sessions: [] });
    expect(h.item(1)).toMatchObject({ status: 'failed', error: MESSAGES.setupAtLimit });
  });
});

describe('the queue during a usage limit (PRD R38)', () => {
  it("holds a queued start in the limited session's provider until the reset", () => {
    const h = new Harness({ settings: { ...new Harness().settings, sessions: { ...new Harness().settings.sessions, concurrency: 5 } } });
    const id = heldTask(h);

    h.act({ type: 'marker', sessionId: id, state: 'failed', detail: 'rate_limit', limit: USAGE });

    const [triage] = h.poll(issue('15619'));

    expect(h.triaged(triage, 'dev:develop')).toEqual([]);
    expect(h.status(2)).toBe('queued');
    expect(queueWaits(h.store, h.item(2), 5, undefined, 'claude', h.now)).toEqual([{ kind: 'limit', provider: 'claude', until: RESET }]);
    expect(queueWaits(h.store, h.item(2), 5, undefined, 'codex', h.now)).toEqual([]);

    h.now = RESET;
    expect(h.act({ type: 'tick' })).toEqual([expect.objectContaining({ type: 'start-session', workItemId: 2 })]);
  });

  it('does not hold the queue for a throttle or a limit with no reset time', () => {
    const h = new Harness({ settings: { ...new Harness().settings, sessions: { ...new Harness().settings.sessions, concurrency: 5 } } });
    const id = heldTask(h);

    h.act({ type: 'marker', sessionId: id, state: 'failed', detail: 'rate_limit', limit: { ...USAGE, kind: 'throttle' } });

    const [triage] = h.poll(issue('15619'));

    expect(h.triaged(triage, 'dev:develop')).toEqual([expect.objectContaining({ type: 'start-session', workItemId: 2 })]);
  });
});
