import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { MESSAGES } from '../src/flow.js';
import { Harness, MINUTE, issue } from './flowHarness.js';

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

describe('answering on the row (PRD R70)', () => {
  it('sends the answer through the background service and changes nothing until the session runs', () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    expect(h.act({ type: 'answer', workItemId: item, nativeSessionId: 'native-1', question: 'Which?', answer: 'Birch' })).toEqual([{ type: 'reply-session', sessionId: session, shortId: 'abc12341', text: 'Birch' }]);
    expect(h.item(item)).toMatchObject({ status: 'running', error: null });
    expect(h.store.session(session)?.state).toBe('waiting');
  });

  it('refuses an empty answer, a session that is not waiting, a released or interactive one, and a work item without a session', () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    expect(h.send({ type: 'answer', workItemId: item, nativeSessionId: 'native-1', question: 'Which?', answer: '  ' })).toEqual({ actions: [], refused: 'The answer is empty.' });

    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.send({ type: 'answer', workItemId: item, nativeSessionId: 'native-1', question: 'Which?', answer: 'Birch' })).toEqual({ actions: [], refused: 'The session is not waiting on a question.' });
    expect(h.send({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' })).toEqual({ actions: [], refused: 'The session is not waiting on a question.' });

    // The operator resumed it in a VS Code tab, where it waits: that tab answers it, not the background service.
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: null, interactive: true }] });
    expect(h.store.session(session)).toMatchObject({ state: 'waiting', released: true });
    expect(h.send({ type: 'answer', workItemId: item, nativeSessionId: 'native-1', question: 'Which?', answer: 'Birch' }).refused).toBe('The work item has no session running in its background process.');
    expect(h.send({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' }).refused).toBe('The work item has no session running in its background process.');

    h.poll(issue('1'), issue('2'));
    const triage = h.act({ type: 'triage-succeeded', triageId: 2, context: 'c', playbook: 'dev:question', immediacy: null, severity: null, model: null });
    expect(triage).toEqual([]);
    expect(h.send({ type: 'answer', workItemId: 2, nativeSessionId: 'native-1', question: 'Which?', answer: 'Birch' }).refused).toBe('The work item has no session running in its background process.');
    expect(h.send({ type: 'open-question', workItemId: 2, nativeSessionId: 'native-1' }).refused).toBe('The work item has no session running in its background process.');
    expect(h.send({ type: 'answer', workItemId: 99, nativeSessionId: 'native-1', question: 'Which?', answer: 'Birch' }).refused).toBe('Unknown work item 99.');
  });

  it("refuses an answer or Open in Claude for a session other than the row's, such as a newer one after the row was drawn", () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    h.act({ type: 'stop', workItemId: item });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });
    h.triaged(h.act({ type: 'retriage', workItemId: item })[0], 'dev:question');
    const next = (h.act({ type: 'start', workItemId: item })[0] as Extract<FlowAction, { type: 'start-session' }>).sessionId;
    h.act({ type: 'session-started', sessionId: next, nativeSessionId: 'native-new', shortId: 'def12345' });
    h.act({ type: 'marker', sessionId: next, state: 'waiting', detail: null });

    expect(h.send({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' })).toEqual({ actions: [], refused: 'The work item has another session now.' });
    expect(h.send({ type: 'answer', workItemId: item, nativeSessionId: 'native-1', question: 'Which?', answer: 'Oak' }).refused).toBe('The work item has another session now.');
    expect(h.act({ type: 'open-question', workItemId: item, nativeSessionId: 'native-new' })).toEqual([{ type: 'stop-session', sessionId: next, shortId: 'def12345', reason: 'open' }]);
  });

  it('refuses a session still starting', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    h.act({ type: 'start', workItemId: 1 });

    expect(h.send({ type: 'answer', workItemId: 1, nativeSessionId: 'native-1', question: 'Which?', answer: 'Birch' }).refused).toBe('The work item has no session running in its background process.');
  });

  it('notes a failed answer on the work item and leaves the session waiting, so it can be answered again', () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    h.act({ type: 'reply-failed', sessionId: session, message: "Claude's background service is not running." });

    expect(h.item(item)).toMatchObject({ status: 'running', error: "Answer failed: Claude's background service is not running." });
    expect(h.store.session(session)?.state).toBe('waiting');
    expect(h.act({ type: 'answer', workItemId: item, nativeSessionId: 'native-1', question: 'Which?', answer: 'Oak' })).toHaveLength(1);
  });
});

describe('Open in Claude (PRD R70)', () => {
  it('stops the waiting session, blocks the work item with its reason, and runs it again when the tab resumes it', () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    expect(h.act({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' })).toEqual([{ type: 'stop-session', sessionId: session, shortId: 'abc12341', reason: 'open' }]);
    expect(h.item(item).status).toBe('running');

    h.now += MINUTE;
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'open' });
    expect(h.item(item)).toMatchObject({ status: 'blocked', error: MESSAGES.openedToAnswer });
    expect(h.store.session(session)).toMatchObject({ state: 'ended', released: true, outcome: 'stopped', outcomeDetail: 'Opened in Claude to answer.' });

    // The tab asks the question again, then runs once answered.
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: null, interactive: true }] });
    expect(h.item(item)).toMatchObject({ status: 'running', error: null });
    expect(h.store.session(session)).toMatchObject({ state: 'waiting', outcome: null, released: true });
  });

  it('returns a work item that held an approval to awaiting approval with the reason', () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: null });
    h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null });
    expect(h.item(item).status).toBe('awaiting-approval');

    h.act({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'open' });

    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', error: MESSAGES.openedToAnswer, approvalPrompt: '/publish' });
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

describe('History of answers (PRD R59, R70)', () => {
  it('logs the answer, Open in Claude, refusals and a failed answer', () => {
    const h = new Harness();
    const { item, session } = waiting(h);

    h.act({ type: 'answer', workItemId: item, nativeSessionId: 'native-1', question: 'Which?', answer: 'Birch' });
    h.send({ type: 'answer', workItemId: item, nativeSessionId: 'native-1', question: 'Which?', answer: '' });
    h.act({ type: 'reply-failed', sessionId: session, message: 'no such session' });
    h.act({ type: 'open-question', workItemId: item, nativeSessionId: 'native-1' });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'open' });

    const events = h.store.ticketHistory(1)!.events.filter((event) => ['answer', 'reply-failed', 'open-question', 'stop-succeeded'].includes(event.type));

    expect(events.map((event) => ({ type: event.type, actor: event.actor, detail: event.detail, refused: event.refused }))).toEqual([
      { type: 'answer', actor: 'operator', detail: { answer: 'Birch' }, refused: null },
      { type: 'answer', actor: 'operator', detail: { answer: '' }, refused: 'The answer is empty.' },
      { type: 'reply-failed', actor: 'hub', detail: { message: 'no such session' }, refused: null },
      { type: 'open-question', actor: 'operator', detail: null, refused: null },
      { type: 'stop-succeeded', actor: 'hub', detail: { reason: 'open' }, refused: null },
    ]);
    expect(events[2]!.changes[0]!.fields).toEqual({ error: [null, 'Answer failed: no such session'] });
    expect(events[4]!.changes.find((change) => change.entity === 'workItem')!.fields).toMatchObject({ status: ['running', 'blocked'], error: ['Answer failed: no such session', MESSAGES.openedToAnswer] });
  });
});
