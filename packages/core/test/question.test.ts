import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { groupOf, holdsSlot, markOf, START_PROMPT } from '../src/group.js';
import { Harness, MINUTE, issue, settings } from './flowHarness.js';

/** A dev:question task session for ticket `key`, started and waiting on a question in its background process. */
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
  const view = { ...h.item(item), sessions: h.store.sessionsFor(item), approvalSends: false };

  return { group: groupOf(view), mark: markOf(view), holdsSlot: holdsSlot(view) };
}

describe('Open in Claude refusals (PRD R70)', () => {
  it('refuses a session that is not waiting, a released or interactive one, and a work item without a session', () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.send({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' })).toEqual({ actions: [], refused: 'The session is not waiting on a question.' });

    // The operator resumed it in a VS Code tab, where it waits: that tab answers it.
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: null, interactive: true }] });
    expect(h.store.session(session)).toMatchObject({ state: 'waiting', released: true });
    expect(h.send({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' }).refused).toBe('The work item has no session running in its background process.');

    h.poll(issue('1'), issue('2'));
    const triage = h.act({ type: 'triage-succeeded', triageId: 2, context: 'c', playbook: 'dev:question', immediacy: null, severity: null, model: null });
    expect(triage).toEqual([]);
    expect(h.send({ type: 'open-question', workItemId: 2, nativeSessionId: 'native-1' }).refused).toBe('The work item has no session running in its background process.');
    expect(h.send({ type: 'open-question', workItemId: 99, nativeSessionId: 'native-1' }).refused).toBe('Unknown work item 99.');
  });

  it("refuses a session other than the row's, such as a newer one after the row was drawn", () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    h.act({ type: 'stop', workItemId: item });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });
    h.triaged(h.act({ type: 'retriage', workItemId: item })[0], 'dev:question');
    const next = (h.act({ type: 'start', workItemId: item })[0] as Extract<FlowAction, { type: 'start-session' }>).sessionId;
    h.act({ type: 'session-started', sessionId: next, nativeSessionId: 'native-new', shortId: 'def12345' });
    h.act({ type: 'marker', sessionId: next, state: 'waiting', detail: null });

    expect(h.send({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' })).toEqual({ actions: [], refused: 'The work item has another session now.' });
    expect(h.act({ type: 'open-question', workItemId: item, nativeSessionId: 'native-new' })).toEqual([{ type: 'stop-session', sessionId: next, provider: 'claude', shortId: 'def12345', reason: 'open' }]);
  });

  it('refuses a session still starting', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    h.act({ type: 'start', workItemId: 1 });

    expect(h.send({ type: 'open-question', workItemId: 1, nativeSessionId: 'native-1' }).refused).toBe('The work item has no session running in its background process.');
  });
});

describe('Open in Claude (PRD R70)', () => {
  it('stops the waiting session and keeps the status and the question until the tab resumes it', () => {
    const h = new Harness();
    const { item, session } = waiting(h);
    const before = h.item(item);
    const asked = h.store.session(session)!.stateAt;

    expect(h.act({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' })).toEqual([{ type: 'stop-session', sessionId: session, provider: 'claude', shortId: 'abc12341', reason: 'open' }]);

    h.now += MINUTE;
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'open' });
    expect(h.item(item)).toMatchObject({ status: 'running', error: null, statusAt: before.statusAt });
    expect(h.store.session(session)).toMatchObject({ state: 'ended', released: true, outcome: 'opened', outcomeDetail: null, stateAt: asked });
    expect(shown(h, item)).toEqual({ group: 'blocked', mark: 'question', holdsSlot: false });

    // Neither a roster without the session nor a background listing read before the stop changes anything.
    h.act({ type: 'roster', sessions: [] });
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: null }] });
    h.act({ type: 'roster', sessions: [] });
    expect(h.item(item)).toMatchObject({ status: 'running', error: null });
    expect(h.store.session(session)).toMatchObject({ state: 'ended', outcome: 'opened' });

    // A tab listed idle has not answered, so neither it nor closing it settles the run or moves the clock.
    h.now += MINUTE;
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'idle', detail: null, interactive: true }] });
    h.act({ type: 'roster', sessions: [] });
    expect(h.item(item)).toMatchObject({ status: 'running', error: null });
    expect(h.store.session(session)).toMatchObject({ state: 'ended', outcome: 'opened', stateAt: asked });
    expect(shown(h, item)).toEqual({ group: 'blocked', mark: 'question', holdsSlot: false });

    // The tab asks the question again, then runs once answered.
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: null, interactive: true }] });
    expect(h.store.session(session)).toMatchObject({ state: 'waiting', outcome: null, released: true });
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'running', error: null });
    expect(shown(h, item)).toEqual({ group: 'progress', mark: 'running', holdsSlot: true });

    // The tab's turn ends without a report, which settles the run as any resumed turn does.
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(item).status).toBe('blocked');
  });

  it('keeps a held approval waiting on the question', () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: null });
    h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null });
    expect(h.item(item).status).toBe('awaiting-approval');

    h.act({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'open' });

    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', error: null, approvalPrompt: '/publish' });
    expect(shown(h, item)).toMatchObject({ group: 'review', mark: 'question' });
  });

  it('notes a failed stop and leaves the session waiting', () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    h.act({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' });
    h.act({ type: 'stop-failed', sessionId: session, reason: 'open', message: 'timed out' });

    expect(h.item(item)).toMatchObject({ status: 'running', error: 'Stop failed: timed out' });
    expect(h.store.session(session)?.state).toBe('waiting');
    expect(h.act({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' })).toHaveLength(1);
  });
});

describe('History of Open in Claude (PRD R59, R70)', () => {
  it('logs Open in Claude, its refusal and the stop, which changes no work item', () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    h.send({ type: 'open-question', workItemId: item, nativeSessionId: 'native-other' });
    h.act({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'open' });

    const events = h.store.ticketHistory(1)!.events.filter((event) => ['open-question', 'stop-succeeded'].includes(event.type));

    expect(events.map((event) => ({ type: event.type, actor: event.actor, detail: event.detail, refused: event.refused }))).toEqual([
      { type: 'open-question', actor: 'operator', detail: null, refused: 'The work item has another session now.' },
      { type: 'open-question', actor: 'operator', detail: null, refused: null },
      { type: 'stop-succeeded', actor: 'hub', detail: { reason: 'open' }, refused: null },
    ]);
    expect(events[2]!.changes.map((change) => change.entity)).toEqual(['session']);
    expect(events[2]!.changes[0]!.fields).toMatchObject({ state: ['waiting', 'ended'], outcome: [null, 'opened'] });
  });
});

describe('Codex questions (PRD R70)', () => {
  /** A Codex dev:question task session for ticket 1, started and running in its background process. */
  function codexRunning(h: Harness): { item: number; session: string } {
    const [triage] = h.poll(issue('1'));
    const item = (triage as Extract<FlowAction, { type: 'triage' }>).workItemId!;

    h.triaged(triage, 'dev:question');
    const start = h.act({ type: 'start', workItemId: item })[0] as Extract<FlowAction, { type: 'start-session' }>;

    expect(start.provider).toBe('codex');
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

  it('opens a waiting Codex question in Codex, keeping the status and the question mark until the session reports again', () => {
    const h = codexHarness();
    const { item, session } = codexRunning(h);

    h.act({ type: 'report', sessionId: session, report: { kind: 'question', text: 'Which tree?' } });
    h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null });
    expect(h.act({ type: 'open-question', workItemId: item, nativeSessionId: 'thread-1' })).toEqual([{ type: 'stop-session', sessionId: session, provider: 'codex', shortId: 'thread-1', reason: 'open' }]);
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'open' });

    expect(h.item(item)).toMatchObject({ status: 'running', error: null });
    expect(h.store.session(session)).toMatchObject({ state: 'ended', question: null, outcome: 'opened' });
    expect(shown(h, item)).toMatchObject({ group: 'blocked', mark: 'question' });

    // The Codex panel's run reports, so the question was answered.
    h.report(session, { kind: 'stage', stage: 'Answered' });
    expect(h.store.session(session)?.outcome).toBeNull();
    expect(shown(h, item)).toMatchObject({ group: 'progress', mark: 'running' });
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
  it('starts waiting, blocks on the operator, refuses Open in Claude, and runs once answered', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const item = (triage as Extract<FlowAction, { type: 'triage' }>).workItemId!;
    h.triaged(triage, 'dev:question');
    const session = (h.act({ type: 'start', workItemId: item })[0] as Extract<FlowAction, { type: 'start-session' }>).sessionId;

    h.act({ type: 'session-started', sessionId: session, nativeSessionId: 'native-1', shortId: 'abc12341', startPrompt: true });
    expect(h.store.session(session)).toMatchObject({ state: 'waiting', stateDetail: START_PROMPT, shortId: 'abc12341' });
    expect(shown(h, item)).toEqual({ group: 'blocked', mark: 'question', holdsSlot: false });
    expect(h.send({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' }).refused).toBe('The session waits on a prompt before it starts; open it in a terminal to answer it.');

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

    expect(h.act({ type: 'stop', workItemId: item })).toEqual([{ type: 'stop-session', sessionId: session, provider: 'claude', shortId: 'abc12341', reason: 'operator' }]);
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });
    expect(h.store.session(session)?.state).toBe('ended');
  });
});
