import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { launchOptions, MESSAGES } from '../src/flow.js';
import { Harness, issue, playbooks, settings } from './flowHarness.js';

function only<T extends FlowAction['type']>(actions: FlowAction[], type: T): Extract<FlowAction, { type: T }> {
  expect(actions.map((action) => action.type)).toEqual([type]);

  return actions[0] as Extract<FlowAction, { type: T }>;
}

/** Marks the action's session as a Code Mode session held in the terminal holder, as `sessions.codeMode` does at its start, and starts it (PRD R93). */
function held(h: Harness, action: FlowAction | undefined, launchId = 'launch-1'): string {
  if (action?.type !== 'start-session') {
    throw new Error(`Expected a start-session action, got ${JSON.stringify(action)}`);
  }

  h.store.updateSession(action.sessionId, { codeMode: true });
  h.act({ type: 'session-started', sessionId: action.sessionId, nativeSessionId: `${action.sessionId}-native-uuid`, shortId: `${action.sessionId}-short`, launchId });

  return action.sessionId;
}

const release = (sessionId: string) => ({ type: 'stop-session', sessionId, provider: 'claude', shortId: `${sessionId}-short`, reason: 'release', codeMode: true });

/** A held task session of an approval playbook, started by Start. */
function heldTask(h: Harness): string {
  const [triage] = h.poll(issue('7'));

  h.triaged(triage, 'dev:question');

  return held(h, h.act({ type: 'start', workItemId: 1 })[0]);
}

/** A held setup session of a playbook that needs a worktree. */
function heldSetup(h: Harness): string {
  const [triage] = h.poll(issue('15619'));

  return held(h, h.triaged(triage, 'dev:develop')[0]);
}

describe('sessions.codeMode (PRD R93)', () => {
  const adhoc = (h: Harness, prompt = 'Write hello.txt') => only(h.act({ type: 'adhoc', prompt, repoRoot: 'D:/scratch', start: true }), 'start-session');

  it('starts a background Claude session while it is off', () => {
    const h = new Harness();
    const start = adhoc(h);

    expect(start.codeMode).toBeUndefined();
    expect(start.nativeSessionId).toBeUndefined();
    expect(start.launchId).toBeUndefined();
    expect(h.store.session(start.sessionId)).toMatchObject({ codeMode: false, nativeSessionId: null, launchId: null, state: 'starting' });
  });

  it('starts a Code Mode session with its Claude session ID and launch stored before the start while it is on', () => {
    const h = new Harness({ settings: settings({ sessions: { codeMode: true } }) });
    const start = adhoc(h);

    expect(start).toMatchObject({ provider: 'claude', codeMode: true, nativeSessionId: 'uuid-1', launchId: 'uuid-2' });
    expect(h.store.session(start.sessionId)).toMatchObject({ codeMode: true, nativeSessionId: 'uuid-1', launchId: 'uuid-2', shortId: null, state: 'starting' });
  });

  it('starts setup and task sessions of a playbook in Code Mode', () => {
    const h = new Harness({ settings: settings({ sessions: { codeMode: true } }) });
    const [triage] = h.poll(issue('15619'));
    const setup = only(h.triaged(triage, 'dev:develop'), 'start-session');

    expect(setup).toMatchObject({ kind: 'setup', codeMode: true, nativeSessionId: 'uuid-1', launchId: 'uuid-2' });
  });

  it('drops the IDs of a start that failed, so the session cannot be resumed', () => {
    const h = new Harness({ settings: settings({ sessions: { codeMode: true } }) });
    const start = adhoc(h);

    h.act({ type: 'session-start-failed', sessionId: start.sessionId, message: 'Code Mode sessions need sessions.installHooks.' });

    expect(h.store.session(start.sessionId)).toMatchObject({ state: 'ended', outcome: 'failed', codeMode: true, nativeSessionId: null, launchId: null, shortId: null });
    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'Code Mode sessions need sessions.installHooks.' });
  });

  it('leaves Codex sessions as they are', () => {
    const h = new Harness({ settings: settings({ sessions: { codeMode: true, provider: 'codex' } }) });
    const start = adhoc(h);

    expect(start.provider).toBe('codex');
    expect(start.codeMode).toBeUndefined();
    expect(h.store.session(start.sessionId)).toMatchObject({ codeMode: false, nativeSessionId: null, launchId: null });
  });

  it('changes only later starts, so a session keeps the mode it started in', () => {
    const h = new Harness({ settings: settings({ sessions: { codeMode: true, concurrency: 2 } }) });
    const first = held(h, adhoc(h, 'First'), 'uuid-2');

    h.settings = settings({ sessions: { codeMode: false, concurrency: 2 } });
    const second = adhoc(h, 'Second');

    expect(second.codeMode).toBeUndefined();
    expect(h.store.session(first)).toMatchObject({ codeMode: true, launchId: 'uuid-2' });
    expect(h.store.session(second.sessionId)).toMatchObject({ codeMode: false });
  });
});

describe('Code Mode sessions in the flow (PRD R93-R95)', () => {
  it('records the launch of a started session', () => {
    const h = new Harness();
    const id = heldTask(h);

    expect(h.store.session(id)).toMatchObject({ codeMode: true, launchId: 'launch-1', nativeSessionId: `${id}-native-uuid`, state: 'running' });
  });

  it('keeps a held task session running after its turn, unlike a background session', () => {
    const h = new Harness();
    const id = heldTask(h);

    expect(h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null })).toEqual([]);
    expect(h.store.session(id)).toMatchObject({ state: 'idle', released: false, releasing: false });
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.turnEndedWithoutApproval });
  });

  it('ends a held setup session at its turn end and starts the task once a worktree is linked, before the process has ended', () => {
    const h = new Harness();
    const setup = heldSetup(h);

    h.report(setup, { kind: 'worktree', path: 'D:/git/widgets-wt/15619', branch: '15619-fix' });

    const actions = h.act({ type: 'marker', sessionId: setup, state: 'idle', detail: null });

    expect(actions[0]).toEqual(release(setup));
    expect(actions[1]).toMatchObject({ type: 'start-session', kind: 'task', cwd: 'D:/git/widgets-wt/15619' });
    expect(h.store.session(setup)).toMatchObject({ released: false, releasing: true, outcome: 'done' });
    expect(h.status(1)).toBe('running');

    expect(h.act({ type: 'stop-succeeded', sessionId: setup, reason: 'release', shortId: `${setup}-short` })).toEqual([]);
    expect(h.store.session(setup)).toMatchObject({ state: 'ended', released: true, releasing: false });
    expect(h.status(1)).toBe('running');
  });

  it('fails a held setup whose turn ended without a worktree once its process has ended', () => {
    const h = new Harness();
    const setup = heldSetup(h);

    expect(h.act({ type: 'marker', sessionId: setup, state: 'idle', detail: null })).toEqual([release(setup)]);
    expect(h.status(1)).toBe('setup');

    h.act({ type: 'stop-succeeded', sessionId: setup, reason: 'release', shortId: `${setup}-short` });
    expect(h.item(1)).toMatchObject({ status: 'failed', error: MESSAGES.setupWithoutWorktree });
  });

  it('ends a held session whose work item becomes done: at once after its turn, at its turn end during one', () => {
    const h = new Harness();
    const idle = heldTask(h);

    h.act({ type: 'marker', sessionId: idle, state: 'idle', detail: null });
    expect(h.act({ type: 'mark-done', workItemId: 1 })).toEqual([release(idle)]);

    const other = new Harness();
    const running = heldTask(other);

    expect(other.act({ type: 'mark-done', workItemId: 1 })).toEqual([]);
    expect(other.act({ type: 'marker', sessionId: running, state: 'idle', detail: null })).toEqual([release(running)]);
  });

  it('ends an older held session when a newer session of its work item starts', () => {
    const h = new Harness();
    const first = heldTask(h);

    h.report(first, { kind: 'approval', prompt: '/publish 7', summary: 'Post the answer', report: null });
    h.act({ type: 'marker', sessionId: first, state: 'idle', detail: null });

    const actions = h.act({ type: 'approve', workItemId: 1 });

    expect(actions[0]).toEqual(release(first));
    expect(actions[1]).toMatchObject({ type: 'start-session', kind: 'task', prompt: expect.stringContaining('/publish 7') });
  });

  it('cancels a pending end when a new turn starts, and decides again at its turn end', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    h.act({ type: 'mark-done', workItemId: 1 });
    expect(h.store.session(id)).toMatchObject({ releasing: true, released: false });

    h.act({ type: 'marker', sessionId: id, state: 'running', detail: null });
    expect(h.store.session(id)).toMatchObject({ releasing: false, released: false });
    expect(h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null })).toEqual([release(id)]);
  });

  it('keeps a held session held when its end fails, so the idle limit can end it later', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    h.act({ type: 'mark-done', workItemId: 1 });
    h.act({ type: 'stop-failed', sessionId: id, reason: 'release', message: 'The terminal holder did not answer.', shortId: `${id}-short` });
    expect(h.store.session(id)).toMatchObject({ state: 'idle', releasing: false, released: false });
    expect(h.act({ type: 'held-idle', sessionId: id })).toEqual([release(id)]);
  });

  it('ignores a late failed end of a held session that has ended', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    h.act({ type: 'held-idle', sessionId: id });
    h.act({ type: 'stop-succeeded', sessionId: id, reason: 'release', shortId: `${id}-short` });
    h.act({ type: 'stop-failed', sessionId: id, reason: 'release', message: 'The terminal holder did not answer.', shortId: `${id}-short` });
    expect(h.store.session(id)).toMatchObject({ state: 'ended', released: true, releasing: false });
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.turnEndedWithoutApproval });
  });

  it('ends an idle held session at the idle limit, never one in a turn while hooks are on, and any while they are off', () => {
    const h = new Harness();
    const id = heldTask(h);

    expect(h.act({ type: 'held-idle', sessionId: id })).toEqual([]);
    h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    expect(h.act({ type: 'held-idle', sessionId: id })).toEqual([release(id)]);
    expect(h.item(1).status).toBe('blocked');

    const off = new Harness({ settings: settings({ sessions: { installHooks: false } }) });
    const running = heldTask(off);

    expect(off.act({ type: 'held-idle', sessionId: running })).toEqual([release(running)]);
  });

  describe('holder loss', () => {
    it('blocks the work item of a session in a turn with the cause, not as a finished run', () => {
      const h = new Harness();
      const id = heldTask(h);

      expect(h.act({ type: 'holder-lost', sessionId: id })).toEqual([]);
      expect(h.store.session(id)).toMatchObject({ state: 'ended', released: true, outcome: 'failed', outcomeDetail: MESSAGES.holderStopped });
      expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.holderStopped });
    });

    it('blocks a setup in a turn too', () => {
      const h = new Harness();
      const setup = heldSetup(h);

      h.act({ type: 'holder-lost', sessionId: setup });
      expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.holderStopped });
    });

    it('leaves the work item of a session whose turn had ended as it was', () => {
      const h = new Harness();
      const id = heldTask(h);

      h.report(id, { kind: 'approval', prompt: '/publish 7', summary: 'Post the answer', report: null });
      h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null });
      h.act({ type: 'holder-lost', sessionId: id });
      expect(h.store.session(id)).toMatchObject({ state: 'ended', released: true, outcome: null });
      expect(h.item(1)).toMatchObject({ status: 'awaiting-approval', error: null });
    });

    it('fails a starting session, and ignores a background session', () => {
      const h = new Harness();
      const [triage] = h.poll(issue('7'));

      h.triaged(triage, 'dev:question');
      const start = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

      h.store.updateSession(start.sessionId, { codeMode: true });
      h.act({ type: 'holder-lost', sessionId: start.sessionId });
      expect(h.store.session(start.sessionId)).toMatchObject({ state: 'ended', outcome: 'failed', outcomeDetail: MESSAGES.holderStopped });
      expect(h.item(1)).toMatchObject({ status: 'failed', error: MESSAGES.holderStopped });

      const other = new Harness();
      const [again] = other.poll(issue('7'));

      other.triaged(again, 'dev:question');
      const background = other.started(other.act({ type: 'start', workItemId: 1 })[0]);

      other.act({ type: 'holder-lost', sessionId: background });
      expect(other.store.session(background)).toMatchObject({ state: 'running' });
    });
  });

  describe('Delete', () => {
    it('ends a starting held session in the holder instead of refusing', () => {
      const h = new Harness();
      const [triage] = h.poll(issue('7'));

      h.triaged(triage, 'dev:question');
      const start = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

      h.store.updateSession(start.sessionId, { codeMode: true });
      expect(h.act({ type: 'delete', workItemId: 1 })).toEqual([{ type: 'stop-session', sessionId: start.sessionId, provider: 'claude', shortId: null, reason: 'operator', codeMode: true }]);
      expect(h.store.workItem(1)).toBeNull();
    });

    it('stops every held session of the work item, after its turn too, but not an ended one', () => {
      const h = new Harness();
      const first = heldTask(h);

      h.report(first, { kind: 'approval', prompt: '/publish 7', summary: 'Post the answer', report: null });
      h.act({ type: 'marker', sessionId: first, state: 'idle', detail: null });

      const second = held(h, h.act({ type: 'approve', workItemId: 1 })[1], 'launch-2');

      h.act({ type: 'stop-succeeded', sessionId: first, reason: 'release', shortId: `${first}-short` });
      h.act({ type: 'marker', sessionId: second, state: 'idle', detail: null });
      expect(h.act({ type: 'delete', workItemId: 1 })).toEqual([{ type: 'stop-session', sessionId: second, provider: 'claude', shortId: `${second}-short`, reason: 'operator', codeMode: true }]);
    });
  });

  it('stops a held session in any state with Stop, which blocks the work item', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    expect(h.act({ type: 'stop', workItemId: 1 })).toEqual([{ type: 'stop-session', sessionId: id, provider: 'claude', shortId: `${id}-short`, reason: 'operator', codeMode: true }]);
    h.act({ type: 'stop-succeeded', sessionId: id, reason: 'operator', shortId: `${id}-short` });
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.stopped });
  });

  it('stops an older held session named by its ID, ending it as stopped without blocking the work item, and refuses one that is not held', () => {
    const h = new Harness();
    const first = heldTask(h);

    h.report(first, { kind: 'approval', prompt: '/publish 7', summary: 'Post the answer', report: null });
    h.act({ type: 'marker', sessionId: first, state: 'idle', detail: null });

    const second = held(h, h.act({ type: 'approve', workItemId: 1 })[1], 'launch-2');

    expect(h.act({ type: 'stop', workItemId: 1, sessionId: first })).toEqual([{ type: 'stop-session', sessionId: first, provider: 'claude', shortId: `${first}-short`, reason: 'operator', codeMode: true }]);
    h.act({ type: 'stop-succeeded', sessionId: first, reason: 'operator', shortId: `${first}-short` });
    expect(h.store.session(first)).toMatchObject({ state: 'ended', released: true, outcome: 'stopped', outcomeDetail: MESSAGES.stopped });
    expect(h.store.session(second)).toMatchObject({ state: 'running' });
    expect(h.status(1)).toBe('running');

    expect(h.send({ type: 'stop', workItemId: 1, sessionId: first }).refused).toBe(`Session ${first} is not a running held session of the work item.`);
    expect(h.send({ type: 'stop', workItemId: 1, sessionId: 'nope' }).refused).toBe('Session nope is not a running held session of the work item.');
    expect(h.act({ type: 'stop', workItemId: 1, sessionId: second })).toEqual([{ type: 'stop-session', sessionId: second, provider: 'claude', shortId: `${second}-short`, reason: 'operator', codeMode: true }]);
  });

  it('refuses Open in Claude and Continue in Background', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'marker', sessionId: id, state: 'waiting', detail: 'question' });
    expect(h.send({ type: 'open-question', workItemId: 1, nativeSessionId: `${id}-native-uuid` }).refused).toBe(MESSAGES.codeModeQuestion);
    expect(h.send({ type: 'background', sessionId: id, nativeSessionId: `${id}-native-uuid`, pid: 42, busy: true, workItemIds: [1] }).refused).toBe(MESSAGES.codeModeBackground);
  });

  it('follows an ID change of the held process at once, never as an interactive session', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'roster', sessions: [{ sessionId: id, state: 'running', detail: null, interactive: false }], forks: [{ sessionId: id, nativeSessionId: 'new-native-uuid', shortId: 'new-nati', state: 'idle', detail: null }] });
    expect(h.store.session(id)).toMatchObject({ nativeSessionId: 'new-native-uuid', shortId: 'new-nati', retiredIds: [`${id}-native-uuid`], released: false, state: 'idle' });
  });
});

describe('Code Mode fixes from the step 8 confirming review', () => {
  it('ends a session that reported done like a process end when the holder is lost, so the done recheck still settles', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('7'));
    const id = held(h, h.triaged(triage, 'support:defect')[0]);

    h.report(id, { kind: 'done', assigned: true });
    expect(h.item(1).status).toBe('running');

    h.act({ type: 'holder-lost', sessionId: id });
    const token = h.store.session(id)!.outcomeDetail ?? '';

    h.act({ type: 'done-checked', sessionId: id, token, assigned: false });
    expect(h.item(1).status).toBe('done');
  });

  it('follows a held process back to an ID it retired, as /resume after /clear does', () => {
    const h = new Harness();
    const id = heldTask(h);
    const native = h.store.session(id)!.nativeSessionId!;
    const move = (to: string) =>
      h.act({ type: 'roster', checked: [id], sessions: [{ sessionId: id, state: 'idle', detail: null, interactive: false }], forks: [{ sessionId: id, nativeSessionId: to, shortId: to.slice(0, 8), state: 'idle', detail: null }] });

    move('native-b');
    expect(h.store.session(id)).toMatchObject({ nativeSessionId: 'native-b', retiredIds: [native] });

    move(native);
    expect(h.store.session(id)).toMatchObject({ nativeSessionId: native, retiredIds: ['native-b'] });
  });
});

describe('Code Mode attach and the resume guard (PRD R95)', () => {
  const TREE = [{ pid: 100, created: '133' }, { pid: 101, created: '134' }];

  /** A held task session whose process the holder no longer holds. */
  function ended(h: Harness): string {
    const id = heldTask(h);

    h.act({ type: 'roster', checked: [id], sessions: [{ sessionId: id, state: 'running', detail: null, interactive: false, tree: TREE }] });
    h.act({ type: 'holder-lost', sessionId: id });

    return id;
  }

  it('reads a session without a stored process tree as having none, and stores one as written', () => {
    const h = new Harness();
    const id = heldTask(h);

    expect(h.store.session(id)!.lastTree).toBeNull();
    h.store.updateSession(id, { lastTree: TREE });
    expect(h.store.session(id)!.lastTree).toEqual(TREE);
  });

  it('stores the process tree a roster read gives a held session, without logging it', () => {
    const h = new Harness();
    const id = heldTask(h);

    expect(h.act({ type: 'roster', checked: [id], sessions: [{ sessionId: id, state: 'running', detail: null, interactive: false, tree: TREE }] })).toEqual([]);
    expect(h.store.session(id)!.lastTree).toEqual(TREE);

    h.act({ type: 'roster', checked: [id], sessions: [{ sessionId: id, state: 'running', detail: null, interactive: false, tree: [] }] });
    expect(h.store.session(id)!.lastTree).toEqual(TREE);

    const changes = h.store.ticketHistory(1)!.events.flatMap((event) => event.changes);

    expect(changes.some((change) => 'lastTree' in change.fields)).toBe(false);
  });

  it('does not store a tree for a background session', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('7'));

    h.triaged(triage, 'dev:question');
    const id = h.started(h.act({ type: 'start', workItemId: 1 })[0]);

    h.act({ type: 'roster', checked: [id], sessions: [{ sessionId: id, state: 'running', detail: null, interactive: false, tree: TREE }] });
    expect(h.store.session(id)!.lastTree).toBeNull();
  });

  it('holds an ended session again on a resume, leaving its outcome and work item as they were', () => {
    const h = new Harness();
    const id = ended(h);

    expect(h.act({ type: 'held-resumed', sessionId: id, launchId: 'launch-2' })).toEqual([]);
    expect(h.store.session(id)).toMatchObject({ state: 'idle', stateDetail: null, endedAt: null, released: false, releasing: false, launchId: 'launch-2', lastTree: null, outcome: 'failed' });
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.holderStopped });

    h.act({ type: 'marker', sessionId: id, state: 'running', detail: null });
    expect(h.status(1)).toBe('running');
  });

  it('stores the launch of a resume about to spawn on the ended session, and nothing for a live one', () => {
    const h = new Harness();
    const id = ended(h);

    expect(h.act({ type: 'held-resuming', sessionId: id, launchId: 'launch-2' })).toEqual([]);
    expect(h.store.session(id)).toMatchObject({ state: 'ended', launchId: 'launch-2', released: true });

    const live = new Harness();
    const running = heldTask(live);

    live.act({ type: 'held-resuming', sessionId: running, launchId: 'launch-2' });
    expect(live.store.session(running)).toMatchObject({ state: 'running', launchId: 'launch-1' });
  });

  it('ignores a resume of a live session or a background session', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'held-resumed', sessionId: id, launchId: 'launch-2' });
    expect(h.store.session(id)).toMatchObject({ state: 'running', launchId: 'launch-1' });

    const other = new Harness();
    const [triage] = other.poll(issue('7'));

    other.triaged(triage, 'dev:question');
    const background = other.started(other.act({ type: 'start', workItemId: 1 })[0]);

    other.act({ type: 'stop', workItemId: 1 });
    other.act({ type: 'stop-succeeded', sessionId: background, reason: 'operator', shortId: 'abc12345' });
    other.act({ type: 'held-resumed', sessionId: background, launchId: 'launch-2' });
    expect(other.store.session(background)).toMatchObject({ state: 'ended', launchId: null });
  });

  it("stops the processes an ended session's last run left, and clears its tree once they have ended", () => {
    const h = new Harness();
    const id = ended(h);

    expect(h.act({ type: 'stop', workItemId: 1 })).toEqual([{ type: 'stop-session', sessionId: id, provider: 'claude', shortId: `${id}-short`, reason: 'operator', codeMode: true, leftovers: true }]);
    h.act({ type: 'stop-succeeded', sessionId: id, reason: 'operator', shortId: `${id}-short`, leftovers: true });
    expect(h.store.session(id)).toMatchObject({ state: 'ended', lastTree: null, outcome: 'failed' });
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.holderStopped });
    expect(h.send({ type: 'stop', workItemId: 1 }).refused).toBe('The work item has no active session.');
  });

  it('shows a failed stop of those processes on the work item', () => {
    const h = new Harness();
    const id = ended(h);

    h.act({ type: 'stop', workItemId: 1 });
    h.act({ type: 'stop-failed', sessionId: id, reason: 'operator', message: 'Process 100 could not be ended: Access is denied.', shortId: `${id}-short`, leftovers: true });
    expect(h.item(1).error).toBe('Stop failed: Process 100 could not be ended: Access is denied.');
    expect(h.store.session(id)!.lastTree).toEqual(TREE);
  });

  it('refuses Stop of an ended session that left no process tree', () => {
    const h = new Harness();
    const id = heldTask(h);

    h.act({ type: 'holder-lost', sessionId: id });
    expect(h.send({ type: 'stop', workItemId: 1 }).refused).toBe('The work item has no active session.');
  });
});

describe('launchOptions', () => {
  it("takes a task session's playbook mode and model, and the settings' for a setup session or another provider", () => {
    const all = playbooks();
    const own = all.get('dev:question')!;
    const s = settings({ sessions: { permissionMode: 'auto', model: 'haiku', codex: { ...settings().sessions.codex, permissionMode: 'bypassPermissions', model: 'gpt-5' } } });

    expect(launchOptions(s, own, 'task', 'claude')).toEqual({ permissionMode: 'plan', model: 'opus' });
    expect(launchOptions(s, own, 'setup', 'claude')).toEqual({ permissionMode: 'auto', model: 'haiku' });
    expect(launchOptions(s, null, 'task', 'codex')).toEqual({ permissionMode: 'bypassPermissions', model: 'gpt-5' });
    expect(launchOptions(settings({ sessions: { model: '' } }), null, 'task', 'claude').model).toBeNull();
  });
});
