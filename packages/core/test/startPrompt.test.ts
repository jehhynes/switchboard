import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { ownPrompt } from '../src/group.js';
import { Harness, issue } from './flowHarness.js';

function only<T extends FlowAction['type']>(actions: FlowAction[], type: T): Extract<FlowAction, { type: T }> {
  expect(actions).toHaveLength(1);
  expect(actions[0]?.type).toBe(type);
  return actions[0] as Extract<FlowAction, { type: T }>;
}

function startEvent(h: Harness) {
  return h.store.ticketHistory(1)!.events.find((event) => event.type === 'start')!;
}

describe('Start with prompt… (PRD R77)', () => {
  it('runs the edited prompt, keeps it for later starts and logs its text with the start', () => {
    const h = new Harness();
    h.act({ type: 'adhoc', prompt: 'Write hello.txt', repoRoot: 'D:/scratch' });

    const start = only(h.act({ type: 'start', workItemId: 1, prompt: '  Write hello.txt\nthen report done\n' }), 'start-session');

    expect(start.prompt).toBe('Write hello.txt\nthen report done');
    expect(h.item(1)).toMatchObject({ status: 'running', taskPrompt: 'Write hello.txt\nthen report done' });
    expect(startEvent(h)).toMatchObject({ actor: 'operator', detail: { prompt: 'Write hello.txt\nthen report done' } });

    h.act({ type: 'session-start-failed', sessionId: start.sessionId, message: 'Workspace not trusted' });
    expect(only(h.act({ type: 'retry', workItemId: 1 }), 'start-session').prompt).toBe('Write hello.txt\nthen report done');
  });

  it('logs no prompt for an unchanged, blank or missing one, and keeps the typed prompt', () => {
    for (const prompt of ['Write hello.txt', '  Write hello.txt\n', '', null, undefined]) {
      const h = new Harness();
      h.act({ type: 'adhoc', prompt: '  Write hello.txt', repoRoot: 'D:/scratch' });

      expect(only(h.act({ type: 'start', workItemId: 1, ...(prompt === undefined ? {} : { prompt }) }), 'start-session').prompt).toBe('  Write hello.txt');
      expect(h.item(1).taskPrompt).toBe('  Write hello.txt');
      expect(startEvent(h).detail).toBeNull();
    }
  });

  it("edits a task report's prompt", () => {
    const h = new Harness();
    h.triaged(h.poll(issue('1'))[0], 'dev:question');
    const session = h.started(h.act({ type: 'start', workItemId: 1 })[0]);
    h.report(session, { kind: 'task', prompt: 'Fix the flaky test', repo: null, title: null });

    expect(h.item(2)).toMatchObject({ status: 'unstarted', playbook: null });
    expect(only(h.act({ type: 'start', workItemId: 2, prompt: 'Fix the flaky test in store.test.ts' }), 'start-session').prompt).toBe('Fix the flaky test in store.test.ts');

    // A repeated report, such as one whose reply was lost, still matches the open work item it made (PRD R68).
    h.report(session, { kind: 'task', prompt: 'Fix the flaky test', repo: null, title: null });
    expect(h.store.workItemsWithParent(1).map((item) => item.id)).toEqual([2]);
  });

  it("refuses a prompt for a work item that runs its playbook's, and neither starts nor changes it", () => {
    const h = new Harness();
    h.triaged(h.poll(issue('1'))[0], 'dev:question');

    expect(h.send({ type: 'start', workItemId: 1, prompt: 'Do something else' }).refused).toBe("The work item runs its playbook's prompt.");
    expect(h.item(1)).toMatchObject({ status: 'unstarted', taskPrompt: null });
  });

  it('shows the prompt in History for a work item without a playbook only', () => {
    const adhoc = new Harness();
    adhoc.act({ type: 'adhoc', prompt: 'Write hello.txt', repoRoot: 'D:/scratch' });
    expect(adhoc.store.ticketHistory(1)!.workItems).toMatchObject([{ prompted: true, prompt: 'Write hello.txt' }]);

    const triaged = new Harness();
    triaged.triaged(triaged.poll(issue('1'))[0], 'dev:question');
    triaged.act({ type: 'start', workItemId: 1 });
    expect(triaged.store.ticketHistory(1)!.workItems).toMatchObject([{ prompted: true, prompt: null }]);
  });

  it('reads the prompt of a work item without a playbook', () => {
    expect(ownPrompt({ playbook: null, taskPrompt: 'Write hello.txt' })).toBe('Write hello.txt');
    expect(ownPrompt({ playbook: null, taskPrompt: null })).toBeNull();
    expect(ownPrompt({ playbook: 'dev:question', taskPrompt: 'Answer Issue 1.' })).toBeNull();
  });
});
