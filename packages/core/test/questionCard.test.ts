import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { groupOf, holdsSlot, markOf, QUESTION_CARD, waitsOnQuestion } from '../src/group.js';
import { Harness, issue, playbooks, settings } from './flowHarness.js';

/** Starts the action's session as a Code Mode session held in the terminal holder (PRD R93). */
function held(h: Harness, action: FlowAction | undefined): string {
  if (action?.type !== 'start-session') {
    throw new Error(`Expected a start-session action, got ${JSON.stringify(action)}`);
  }

  h.store.updateSession(action.sessionId, { codeMode: true });
  h.act({ type: 'session-started', sessionId: action.sessionId, nativeSessionId: `${action.sessionId}-native`, shortId: `${action.sessionId}-short`, launchId: 'launch-1' });

  return action.sessionId;
}

/** A held task session of a playbook: `dev:question` offers approval, so a turn without a card blocks; `dev:read` offers neither, so it finishes. */
function heldTask(h: Harness, playbook = 'dev:question'): string {
  const [triage] = h.poll(issue('7'));

  h.triaged(triage, playbook);

  return held(h, h.act({ type: 'start', workItemId: 1 })[0]);
}

const harness = (sessions: NonNullable<Parameters<typeof settings>[0]>['sessions'] = { codeMode: true }) => new Harness({ settings: settings({ sessions }), playbooks: playbooks(undefined, { 'dev:read': { description: 'Read it', template: 'Read {{ticket.title}}.' } }) });

/** The row's view of the work item, as the dock groups and marks it (PRD R27). */
function row(h: Harness) {
  return { ...h.item(1), sessions: h.store.sessionsFor(1), triage: null, approvalSends: false };
}

describe('a turn that ends with an unanswered question card (PRD R103)', () => {
  it('leaves the work item running with the Answer a question mark in Blocked on you, holding no slot, until the next message runs a turn', () => {
    const h = harness();
    const id = heldTask(h);

    h.act({ type: 'marker', sessionId: id, state: 'running', detail: null });
    h.questionCards.add(id);
    expect(h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null })).toEqual([]);

    expect(h.store.session(id)).toMatchObject({ state: 'idle', stateDetail: QUESTION_CARD });
    expect(h.item(1)).toMatchObject({ status: 'running', error: null, readyAt: null });
    expect(waitsOnQuestion(row(h))).toBe(true);
    expect(groupOf(row(h))).toBe('blocked');
    expect(markOf(row(h))).toBe('question');
    expect(holdsSlot(row(h))).toBe(false);

    // The operator's answer is a message, which starts a turn.
    h.questionCards.delete(id);
    h.act({ type: 'marker', sessionId: id, state: 'running', detail: null });
    expect(h.store.session(id)).toMatchObject({ state: 'running', stateDetail: null });
    expect(markOf(row(h))).toBe('running');
    expect(holdsSlot(row(h))).toBe(true);

    // A turn that then ends without a card settles as before: this playbook offers approval, so it blocks.
    h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    expect(h.store.session(id)).toMatchObject({ state: 'idle', stateDetail: null });
    expect(h.status(1)).toBe('blocked');
    h.store.close();
  });

  it('keeps a work item that would finish from becoming finished, so it never counts as ready', () => {
    const h = harness();
    const id = heldTask(h, 'dev:read');

    h.questionCards.add(id);
    h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    expect(h.item(1)).toMatchObject({ status: 'running', readyAt: null });
    expect(markOf(row(h))).toBe('question');

    // The card was answered while no turn ran, as when a later read finds the message; the next idle reading settles the turn.
    h.questionCards.delete(id);
    h.act({ type: 'roster', sessions: [{ sessionId: id, state: 'idle', detail: null }] });
    expect(h.store.session(id)?.stateDetail).toBeNull();
    expect(h.status(1)).toBe('finished');
    h.store.close();
  });

  it('waits the same way for a Codex app-server session', () => {
    const h = harness({ provider: 'codex' });
    const [triage] = h.poll(issue('7'));

    h.triaged(triage, 'dev:read');
    const start = h.act({ type: 'start', workItemId: 1 })[0] as Extract<FlowAction, { type: 'start-session' }>;
    h.act({ type: 'session-started', sessionId: start.sessionId, nativeSessionId: 'thread-1', shortId: 'thread-1' });
    expect(h.store.session(start.sessionId)?.execution).toBe('app-server');

    h.questionCards.add(start.sessionId);
    h.act({ type: 'marker', sessionId: start.sessionId, state: 'idle', detail: null });
    expect(h.status(1)).toBe('running');
    expect(markOf(row(h))).toBe('question');
    h.store.close();
  });

  it('settles as before for a background session, a hosted conversation, a report, an unassigned ticket, or a hub that reads no cards', () => {
    // A background Claude session has no conversation the view reads.
    const background = harness({ codeMode: false });
    const [triage] = background.poll(issue('7'));
    background.triaged(triage, 'dev:read');
    const start = background.act({ type: 'start', workItemId: 1 })[0] as Extract<FlowAction, { type: 'start-session' }>;
    background.act({ type: 'session-started', sessionId: start.sessionId, nativeSessionId: null, shortId: 'abc12345' });
    background.questionCards.add(start.sessionId);
    background.act({ type: 'marker', sessionId: start.sessionId, state: 'idle', detail: null });
    expect(background.status(1)).toBe('finished');
    background.store.close();

    // A hosted conversation stays open between turns and shows no question.
    const hosted = harness();
    const conversation = hosted.act({ type: 'new-conversation', hostWindow: 'D:/folder', folder: 'D:/folder' })[0] as Extract<FlowAction, { type: 'start-session' }>;
    hosted.act({ type: 'session-started', sessionId: conversation.sessionId, nativeSessionId: 'n', shortId: 'n-short', launchId: 'launch-1' });
    hosted.questionCards.add(conversation.sessionId);
    hosted.act({ type: 'marker', sessionId: conversation.sessionId, state: 'running', detail: null });
    hosted.act({ type: 'marker', sessionId: conversation.sessionId, state: 'idle', detail: null });
    expect(hosted.store.session(conversation.sessionId)?.stateDetail).toBeNull();
    expect(markOf(row(hosted))).toBe('idle');
    hosted.store.close();

    // An approval report decides the turn.
    const approved = harness();
    const asked = heldTask(approved);
    approved.questionCards.add(asked);
    approved.report(asked, { kind: 'approval', prompt: '/publish', summary: 'Posts it.', report: null });
    approved.act({ type: 'marker', sessionId: asked, state: 'idle', detail: null });
    expect(approved.status(1)).toBe('awaiting-approval');
    expect(approved.store.session(asked)?.stateDetail).toBeNull();
    approved.store.close();

    // A ticket that left the assigned state during the turn is done when it ends.
    const unassigned = harness();
    const left = heldTask(unassigned);
    unassigned.questionCards.add(left);
    unassigned.poll(issue('7', false));
    unassigned.act({ type: 'marker', sessionId: left, state: 'idle', detail: null });
    expect(unassigned.status(1)).toBe('done');
    unassigned.store.close();

    // A hub that reads no cards leaves the rule as it was.
    const none = harness();
    const plain = heldTask(none);
    none.act({ type: 'marker', sessionId: plain, state: 'idle', detail: null });
    expect(none.status(1)).toBe('blocked');
    none.store.close();
  });

  it('settles the work item when the held session ends while it waits on the answer', () => {
    const h = harness();
    const id = heldTask(h, 'dev:read');

    h.questionCards.add(id);
    h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    h.act({ type: 'holder-lost', sessionId: id });

    expect(h.store.session(id)).toMatchObject({ state: 'ended', stateDetail: null, outcome: null });
    expect(h.status(1)).toBe('finished');
    expect(waitsOnQuestion(row(h))).toBe(false);
    h.store.close();
  });
});
