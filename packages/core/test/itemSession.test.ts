import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { NEEDS_HOOKS } from '../src/flow.js';
import { Harness, issue, settings } from './flowHarness.js';

function only<T extends FlowAction['type']>(actions: FlowAction[], type: T): Extract<FlowAction, { type: T }> {
  expect(actions.map((action) => action.type)).toEqual([type]);

  return actions[0] as Extract<FlowAction, { type: T }>;
}

const IN_TURN = 'A session of this work item is in a turn. Wait for it to end, or stop it, before starting a new conversation.';

/** A dev:develop work item whose setup made its worktree and whose task session ran a turn and stopped for the operator. */
function developed(h: Harness): { setup: string; task: string } {
  const [triage] = h.poll(issue('15619'));
  const setup = h.started(only(h.triaged(triage, 'dev:develop'), 'start-session'));

  h.report(setup, { kind: 'worktree', path: 'D:/git/widgets-wt/15619', branch: '15619-fix' });
  h.report(setup, { kind: 'done' });

  const task = h.started(only(h.act({ type: 'marker', sessionId: setup, state: 'idle', detail: null }), 'start-session'), 'task1234');

  h.act({ type: 'marker', sessionId: task, state: 'idle', detail: null });

  return { setup, task };
}

describe("New conversation… in a work item (architecture.md § Web page)", () => {
  it("starts a new task session in the work item's worktree with the first message as its prompt, keeping its earlier sessions and its own prompt", () => {
    const h = new Harness();
    const { setup, task } = developed(h);
    const before = h.item(1);
    const start = only(h.act({ type: 'item-session', workItemId: 1, prompt: '  Why did the build fail?  ' }), 'start-session');

    expect(start).toMatchObject({ workItemId: 1, kind: 'task', provider: 'claude', cwd: 'D:/git/widgets-wt/15619', name: 'switchboard · dev:develop · github 15619', codeMode: true });
    expect(start.prompt).toContain('Why did the build fail?');
    expect(start.prompt).not.toContain('/sb-plan');
    expect(h.store.sessionsFor(1).map((one) => one.id)).toEqual([setup, task, start.sessionId]);
    expect(before.status).toBe('blocked');
    expect(h.item(1)).toMatchObject({ status: 'running', playbook: 'dev:develop', taskPrompt: before.taskPrompt, error: null });
    expect(h.store.session(start.sessionId)).toMatchObject({ kind: 'task', promptless: false, cwd: 'D:/git/widgets-wt/15619' });
  });

  it("starts in the provider of the work item's latest session unless another is chosen, and a Codex start in the sessions' own options", () => {
    const h = new Harness({ settings: settings({ sessions: { provider: 'codex' } }) });

    only(h.act({ type: 'new-session', repoRoot: 'D:/scratch', provider: 'codex', prompt: 'Hello' }), 'start-session');
    h.store.updateSession('s1', { state: 'idle' });

    // The earlier Codex thread leaves its subscription, as before any new session of a work item (PRD R39); it stays listed, read-only.
    const [stop, same] = h.act({ type: 'item-session', workItemId: 1, prompt: 'Start over' }) as [Extract<FlowAction, { type: 'stop-session' }>, Extract<FlowAction, { type: 'start-session' }>];

    expect(stop).toMatchObject({ type: 'stop-session', sessionId: 's1', provider: 'codex' });

    expect(same).toMatchObject({ provider: 'codex', execution: 'app-server', cwd: 'D:/scratch', name: '' });
    expect(same.prompt).toContain('Start over');
    h.store.updateSession(same.sessionId, { state: 'idle' });

    const other = h.act({ type: 'item-session', workItemId: 1, prompt: 'Now in Claude', provider: 'claude' }).find((action) => action.type === 'start-session') as Extract<FlowAction, { type: 'start-session' }>;

    expect(other).toMatchObject({ provider: 'claude', codeMode: true, cwd: 'D:/scratch' });
    expect(h.store.sessionsFor(1).map((one) => one.provider)).toEqual(['codex', 'codex', 'claude']);
    // The conversation stays a conversation: no done report, as its first session.
    expect(h.store.session(other.sessionId)!.reports).not.toContain('done');
  });

  it('refuses an empty message, a work item not yet started or done, a session of its ticket in a turn, and Claude without hooks, starting nothing', () => {
    const h = new Harness();
    const { task } = developed(h);

    expect(h.send({ type: 'item-session', workItemId: 1, prompt: '   ' })).toEqual({ actions: [], refused: 'Write the first message of the new conversation.' });

    h.act({ type: 'marker', sessionId: task, state: 'running', detail: null });
    expect(h.send({ type: 'item-session', workItemId: 1, prompt: 'Hi' })).toEqual({ actions: [], refused: IN_TURN });
    h.act({ type: 'marker', sessionId: task, state: 'waiting', detail: null });
    expect(h.send({ type: 'item-session', workItemId: 1, prompt: 'Hi' }).refused).toBe(IN_TURN);
    expect(h.store.sessionsFor(1)).toHaveLength(2);

    h.act({ type: 'adhoc', prompt: 'Later', repoRoot: 'D:/scratch' });
    expect(h.item(2).status).toBe('unstarted');
    expect(h.send({ type: 'item-session', workItemId: 2, prompt: 'Hi' }).refused).toBe('A new conversation starts only in a work item whose work has started and is not done.');

    h.act({ type: 'mark-done', workItemId: 1 });
    expect(h.send({ type: 'item-session', workItemId: 1, prompt: 'Hi' }).refused).not.toBeNull();
    expect(h.store.sessionsFor(1)).toHaveLength(2);

    const off = new Harness({ settings: settings({ sessions: { installHooks: false, provider: 'codex' } }) });

    only(off.act({ type: 'new-session', repoRoot: 'D:/scratch', provider: 'codex' }), 'start-session');
    off.store.updateSession('s1', { state: 'idle' });
    expect(off.send({ type: 'item-session', workItemId: 1, prompt: 'Hi', provider: 'claude' }).refused).toBe(NEEDS_HOOKS);
    expect(off.store.sessionsFor(1)).toHaveLength(1);
  });
});
