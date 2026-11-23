import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { groupOf, holdsSlot, markOf, MARK_TITLES, PERMISSION_PROMPT, START_PROMPT } from '../src/group.js';
import { Harness, issue, settings } from './flowHarness.js';

/** A dev:question task session for ticket `key`, started and waiting on a question in the terminal holder. */
function waiting(h: Harness, key = '1'): { item: number; session: string } {
  const [triage] = h.poll(...[...h.store.tickets('github').filter((t) => t.assigned).map((t) => issue(t.sourceKey)), issue(key)]);
  const item = (triage as Extract<FlowAction, { type: 'triage' }>).workItemId!;
  h.triaged(triage, 'dev:question');
  const start = h.act({ type: 'start', workItemId: item })[0] as Extract<FlowAction, { type: 'start-session' }>;
  const session = start.sessionId;

  h.act({ type: 'session-started', sessionId: session, nativeSessionId: `native-${key}`, shortId: `abc1234${key}` });

  h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null });

  return { item, session };
}

/** The work item's group and mark, as the dock shows them. */
function shown(h: Harness, item: number): { group: string; mark: string | null; holdsSlot: boolean } {
  const view = { ...h.item(item), sessions: h.store.sessionsFor(item), triage: h.store.triagesFor(item).at(-1) ?? null, approvalSends: false };

  return { group: groupOf(view), mark: markOf(view), holdsSlot: holdsSlot(view) };
}

describe('Codex questions (PRD R70)', () => {
  /** A Codex exec dev:question task session for ticket 1, started and running. */
  function codexRunning(h: Harness): { item: number; session: string } {
    const [triage] = h.poll(issue('1'));
    const item = (triage as Extract<FlowAction, { type: 'triage' }>).workItemId!;

    h.triaged(triage, 'dev:question');
    const start = h.act({ type: 'start', workItemId: item })[0] as Extract<FlowAction, { type: 'start-session' }>;

    expect(start.provider).toBe('codex');
    // A persisted exec session keeps the original question handoff.
    h.store.updateSession(start.sessionId, { execution: null });
    h.act({ type: 'session-started', sessionId: start.sessionId, nativeSessionId: 'thread-1', shortId: 'thread-1' });

    return { item, session: start.sessionId };
  }

  const codexHarness = () => new Harness({ settings: settings({ sessions: { provider: 'codex', codex: { permissionMode: 'plan', model: '' } } }) });

  it('keeps the reported question with a new ID for each report, so a report of the same text is told apart', () => {
    const h = codexHarness();
    const { session } = codexRunning(h);

    h.act({ type: 'report', sessionId: session, report: { kind: 'question', text: 'Which tree?' } });
    const asked = h.store.session(session)!.question!;

    expect(asked).toMatchObject({ text: 'Which tree?' });
    h.act({ type: 'report', sessionId: session, report: { kind: 'question', text: 'Which tree?' } });
    expect(h.store.session(session)!.question!.id).not.toBe(asked.id);
  });

  it('takes no question from a session the operator resumed, and drops one when the operator is seen running the session', () => {
    const h = codexHarness();
    const { session } = codexRunning(h);

    h.act({ type: 'report', sessionId: session, report: { kind: 'question', text: 'Which tree?' } });
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'running', detail: null, interactive: true }] });
    expect(h.store.session(session)).toMatchObject({ released: true, question: null });

    h.act({ type: 'report', sessionId: session, report: { kind: 'question', text: 'Again?' } });
    expect(h.store.session(session)!.question).toBeNull();
  });


  it("refuses a question report from a Claude session, whose contract offers AskUserQuestion instead", () => {
    const h = new Harness();
    const { session } = waiting(h);

    expect(h.send({ type: 'report', sessionId: session, report: { kind: 'question', text: 'Which?' } }).refused).toBe("This session's report contract does not offer the question report.");
  });
});

describe('a session waiting on a prompt before it starts (PRD R41)', () => {
  it('starts waiting, blocks on the operator, and runs once answered', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const item = (triage as Extract<FlowAction, { type: 'triage' }>).workItemId!;
    h.triaged(triage, 'dev:question');
    const session = (h.act({ type: 'start', workItemId: item })[0] as Extract<FlowAction, { type: 'start-session' }>).sessionId;

    h.act({ type: 'session-started', sessionId: session, nativeSessionId: 'native-1', shortId: 'abc12341', startPrompt: true });
    expect(h.store.session(session)).toMatchObject({ state: 'waiting', stateDetail: START_PROMPT, shortId: 'abc12341' });
    expect(shown(h, item)).toEqual({ group: 'blocked', mark: 'question', holdsSlot: false });

    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: START_PROMPT, interactive: false }] });
    h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null });
    expect(h.store.session(session)).toMatchObject({ state: 'waiting', stateDetail: START_PROMPT });

    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'running', detail: null, interactive: false }] });
    expect(h.store.session(session)).toMatchObject({ state: 'running', stateDetail: null });
    expect(h.item(item).status).toBe('running');
  });

  it('ends when the operator stops it, as for a process that died at the prompt', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const item = (triage as Extract<FlowAction, { type: 'triage' }>).workItemId!;
    h.triaged(triage, 'dev:question');
    const session = (h.act({ type: 'start', workItemId: item })[0] as Extract<FlowAction, { type: 'start-session' }>).sessionId;
    h.act({ type: 'session-started', sessionId: session, nativeSessionId: 'native-1', shortId: 'abc12341', startPrompt: true });

    expect(h.act({ type: 'stop', workItemId: item })).toEqual([{ type: 'stop-session', sessionId: session, provider: 'claude', shortId: 'abc12341', reason: 'operator', codeMode: true }]);
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });
    expect(h.store.session(session)?.state).toBe('ended');
  });
});

describe('a session waiting on a permission prompt (PRD R70)', () => {
  it('marks Approve a permission, blocks on the operator, and runs once answered', () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: PERMISSION_PROMPT });
    expect(h.store.session(session)).toMatchObject({ state: 'waiting', stateDetail: PERMISSION_PROMPT });
    expect(shown(h, item)).toEqual({ group: 'blocked', mark: 'permission', holdsSlot: false });
    expect(MARK_TITLES.permission).toBe('Approve a permission');

    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(shown(h, item)).toEqual({ group: 'progress', mark: 'running', holdsSlot: true });
  });

  it('is a question again when the roster lists the wait as input needed', () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: PERMISSION_PROMPT, interactive: false }] });
    expect(shown(h, item).mark).toBe('permission');
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: null, interactive: false }] });
    expect(shown(h, item).mark).toBe('question');
  });
});
