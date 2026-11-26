import { describe, expect, it } from 'vitest';
import type { PolledTicket } from '../src/flow.js';
import { MESSAGES } from '../src/flow.js';
import { resumesHeld } from '../src/group.js';
import { Harness, MINUTE, T0, issue, playbooks, settings } from './flowHarness.js';
import { CONTRACT, FINISHING_REPORTS, only } from './flowFixtures.js';

describe('limits and the one-session-in-a-turn rule', () => {
  it('ends only the sessions a roster read looked for, so a start confirmed during the read survives it', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const session = h.started(only(h.triaged(triage, 'support:defect'), 'start-session'));

    expect(h.act({ type: 'roster', sessions: [], checked: [] })).toEqual([]);
    expect(h.store.session(session)!.state).toBe('running');

    h.act({ type: 'roster', sessions: [], checked: [session] });
    expect(h.store.session(session)!.state).toBe('ended');
  });

  it('queues starts beyond the concurrency limit and starts them in order as slots free', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'), issue('3'));

    const first = only(h.triaged(triages[0], 'support:defect'), 'start-session');
    expect(h.triaged(triages[1], 'support:defect')).toEqual([]);
    expect(h.triaged(triages[2], 'support:defect')).toEqual([]);
    expect([1, 2, 3].map((id) => h.status(id))).toEqual(['running', 'queued', 'queued']);

    h.started(first);
    const next = only(h.act({ type: 'roster', sessions: [] }), 'start-session');

    expect(next.workItemId).toBe(2);
    expect(h.status(3)).toBe('queued');
  });

  it('frees the slot of a session waiting on the operator, and takes it back only for new starts once it runs again', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'), issue('3'));
    const first = h.started(only(h.triaged(triages[0], 'support:defect'), 'start-session'));
    h.triaged(triages[1], 'support:defect');
    h.triaged(triages[2], 'support:defect');

    expect(h.act({ type: 'marker', sessionId: first, state: 'running', detail: null })).toEqual([]);

    const second = only(h.act({ type: 'marker', sessionId: first, state: 'waiting', detail: null }), 'start-session');
    expect(second.workItemId).toBe(2);
    h.started(second);

    expect(h.act({ type: 'marker', sessionId: first, state: 'running', detail: null })).toEqual([]);
    expect(h.act({ type: 'roster', sessions: [{ sessionId: first, state: 'running', detail: null }] })).toEqual([]);
    expect([1, 2, 3].map((id) => h.status(id))).toEqual(['running', 'blocked', 'queued']);

    const third = only(h.act({ type: 'roster', sessions: [] }), 'start-session');
    expect(third.workItemId).toBe(3);
  });

  it('frees the slot of a task session whose turn ended while the operator keeps it open, and takes it back when it runs again', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'), issue('3'));
    const first = h.started(only(h.triaged(triages[0], 'support:defect'), 'start-session'));
    h.triaged(triages[1], 'support:defect');
    h.triaged(triages[2], 'support:defect');

    const interactive = [{ sessionId: first, state: 'idle' as const, detail: null, interactive: true }];
    const second = only(h.act({ type: 'roster', sessions: interactive }), 'start-session');
    expect(second.workItemId).toBe(2);
    h.started(second);

    // The operator resumes the first session, so it takes a slot again while the second session ends.
    h.act({ type: 'marker', sessionId: first, state: 'running', detail: null });
    expect(h.act({ type: 'roster', sessions: [{ sessionId: first, state: 'running', detail: null, interactive: true }] })).toEqual([]);
    expect([1, 2, 3].map((id) => h.status(id))).toEqual(['running', 'blocked', 'queued']);

    const third = only(h.act({ type: 'marker', sessionId: first, state: 'failed', detail: 'api' }), 'start-session');
    expect(third.workItemId).toBe(3);
  });

  it('frees the slot of a live session whose work item is done or whose ticket is snoozed', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'), issue('3'));
    const first = h.started(only(h.triaged(triages[0], 'support:defect'), 'start-session'));
    h.triaged(triages[1], 'support:defect');
    h.triaged(triages[2], 'support:defect');

    const second = h.started(only(h.report(first, { kind: 'done' }).actions, 'start-session'));
    expect(h.status(1)).toBe('done');
    expect(h.store.session(first)!.state).not.toBe('ended');

    expect(only(h.act({ type: 'snooze', ticketId: 2, until: null }), 'start-session').workItemId).toBe(3);
    expect(h.store.session(second)!.state).not.toBe('ended');
  });

  it('frees the slot when an approval report moves the work item to Ready for review while its session stays live', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'));
    h.triaged(triages[0], 'dev:question');
    const first = h.started(h.act({ type: 'start', workItemId: 1 })[0]);
    h.triaged(triages[1], 'support:defect');

    expect(h.status(2)).toBe('queued');
    const report = h.send({ type: 'report', sessionId: first, report: { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: null } });
    expect(only(report.actions, 'start-session').workItemId).toBe(2);
    expect(h.status(1)).toBe('awaiting-approval');
  });

  it('keeps the slot of a setup session whose turn ended until its task starts', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'));
    const setup = h.started(only(h.triaged(triages[0], 'dev:develop'), 'start-session'));
    h.triaged(triages[1], 'support:defect');

    h.report(setup, { kind: 'worktree', path: 'D:/wt/1', branch: null });
    h.report(setup, { kind: 'done' });
    const task = only(h.act({ type: 'marker', sessionId: setup, state: 'idle', detail: null }), 'start-session');
    expect(task).toMatchObject({ workItemId: 1, kind: 'task' });
    expect(h.status(2)).toBe('queued');
  });

  it('keeps one work item when its ticket is assigned again while the work item is open', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const session = h.started(only(h.triaged(triage, 'support:defect'), 'start-session'));

    h.poll();
    expect(h.item(1)).toMatchObject({ status: 'running', unassignedAt: T0 });

    expect(h.poll(issue('1'))).toEqual([]);
    expect(h.store.workItem(2)).toBeNull();
    expect(h.item(1).unassignedAt).toBeNull();

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: 'The session finished its turn without reporting done.', warning: null });
  });

  it('holds a reassigned ticket’s new work item while the done work item’s session is still in its turn', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const session = h.started(only(h.triaged(triage, 'support:defect'), 'start-session'));

    h.report(session, { kind: 'done' });
    h.poll();
    const [again] = h.poll(issue('1'));
    expect(h.triaged(again, 'support:defect')).toEqual([]);
    expect(h.status(2)).toBe('queued');

    // The turn's end starts it, before the release stops the earlier session.
    const actions = h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(actions.find((action) => action.type === 'start-session')).toMatchObject({ workItemId: 2 });
  });

  it('finishes a deferred unassignment without a warning when the session ends its turn, fails to start, or is stopped', () => {
    const cases: [string, (h: Harness, session: string) => void][] = [
      ['idle', (h, s) => h.act({ type: 'marker', sessionId: s, state: 'idle', detail: null })],
      ['ended', (h) => h.act({ type: 'roster', sessions: [] })],
      ['start failed', (h, s) => h.act({ type: 'session-start-failed', sessionId: s, message: 'x' })],
      ['stopped', (h, s) => h.act({ type: 'stop-succeeded', sessionId: s, reason: 'operator' })],
    ];

    for (const [name, end] of cases) {
      const h = new Harness();
      const [triage] = h.poll(issue('1'));
      const start = only(h.triaged(triage, 'support:defect'), 'start-session');

      if (name !== 'start failed') {
        h.started(start);
      }

      h.poll();
      end(h, start.sessionId);

      expect({ name, ...h.item(1) }).toMatchObject({ name, status: 'done', doneReason: 'unassigned', warning: null });
    }
  });

  it('finishes a deferred unassignment without a warning when a setup session ends', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const setup = h.started(only(h.triaged(triage, 'dev:develop'), 'start-session'));

    h.report(setup, { kind: 'worktree', path: 'D:/wt/1', branch: null });
    h.poll();
    expect(h.act({ type: 'roster', sessions: [] })).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'done', doneReason: 'unassigned', warning: null });
  });
});

describe('operator actions', () => {
  it('refuses Retry on a work item that has not failed', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));

    expect(h.send({ type: 'retry', workItemId: 1 }).refused).toBe('The work item has not failed.');
    h.triaged(triage, 'dev:question');
    expect(h.send({ type: 'retry', workItemId: 1 }).refused).toBe('The work item has not failed.');

    h.started(h.act({ type: 'start', workItemId: 1 })[0]);
    expect(h.send({ type: 'retry', workItemId: 1 }).refused).toBe('The work item has not failed.');
    expect(h.item(1)).toMatchObject({ status: 'running' });
  });

  it('refuses Retry while a failed work item has an active session', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('15619'));
    const setup = h.started(only(h.triaged(triage, 'dev:develop'), 'start-session'));

    h.act({ type: 'roster', sessions: [] });
    // The operator reopened the setup session in a tab, which has run no turn.
    h.act({ type: 'roster', sessions: [{ sessionId: setup, state: 'idle', detail: null, interactive: true }] });
    expect(h.item(1)).toMatchObject({ status: 'failed', error: MESSAGES.setupWithoutWorktree });
    expect(h.send({ type: 'retry', workItemId: 1 }).refused).toBe('The work item has an active session.');
    expect(h.status(1)).toBe('failed');
  });

  it('keeps the playbook, guidance and readiness when Retry queues a failed start', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 } }) });
    const [first, second] = h.poll(issue('1'), issue('2'));
    h.triaged(first, 'dev:question');
    h.triaged(second, 'dev:question');
    h.started(h.act({ type: 'start', workItemId: 1 })[0]);
    h.store.updateWorkItem(2, { readyAt: T0 });
    h.act({ type: 'start', workItemId: 2, guidance: 'Check the logs.' });
    h.store.updateWorkItem(2, { status: 'failed', error: 'The start failed.' });

    expect(h.act({ type: 'retry', workItemId: 2 })).toEqual([]);
    expect(h.item(2)).toMatchObject({ status: 'queued', queuedAt: T0, error: null, playbook: 'dev:question', guidance: 'Check the logs.', readyAt: T0 });
    expect(h.store.triagesFor(2)).toHaveLength(1);
  });

  it('refuses actions that do not apply', () => {
    const h = new Harness();
    h.poll(issue('1'));

    expect(h.send({ type: 'approve', workItemId: 1 }).refused).toBe('The work item is not awaiting approval.');
    expect(h.send({ type: 'start', workItemId: 1 }).refused).toBe('The work item is not unstarted.');
    expect(h.send({ type: 'approve', workItemId: 7 }).refused).toBe('Unknown work item 7.');
  });

  it('fails a start whose playbook is no longer loaded or does not render', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'dev:bad': { description: 'Bad', template: 'Use {{nope}}.' } }) });
    const triages = h.poll(issue('1'), issue('2'));
    h.triaged(triages[0], 'dev:question');
    h.triaged(triages[1], 'dev:bad');

    h.playbooks.delete('dev:question');
    h.act({ type: 'start', workItemId: 1 });
    h.act({ type: 'start', workItemId: 2 });

    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'Playbook dev:question is not loaded.' });
    expect(h.item(2)).toMatchObject({ status: 'failed', error: 'Playbook dev:bad: Unknown template variable: nope.' });
  });
});

describe('ad-hoc', () => {
  it('starts the typed prompt in the chosen repo as the operator when asked to, numbering tickets locally', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 } }) });
    const start = only(h.act({ type: 'adhoc', prompt: '  Write hello.txt\nthen report done', repoRoot: 'D:/scratch', start: true }), 'start-session');

    expect(start).toEqual({
      type: 'start-session',
      provider: 'claude',
      sessionId: 's1',
      workItemId: 1,
      kind: 'task',
      cwd: 'D:/scratch',
      prompt: '  Write hello.txt\nthen report done',
      contract: CONTRACT('s1', ['stage', 'worktree', 'done', 'approval', 'link', 'paste', 'task']),
      name: 'switchboard · ad-hoc · adhoc 1',
      permissionMode: 'auto',
      model: null,
      codeMode: true,
      withoutCodeMode: true,
      nativeSessionId: 'uuid-1',
      launchId: 'uuid-2',
    });
    expect(h.store.ticket(1)).toMatchObject({ source: 'adhoc', sourceKey: '1', title: 'Write hello.txt', repoRoot: 'D:/scratch' });
    expect(h.item(1)).toMatchObject({ playbook: null, taskPrompt: '  Write hello.txt\nthen report done', status: 'running' });

    h.act({ type: 'adhoc', prompt: 'Second', repoRoot: 'D:/scratch', start: true });
    expect(h.store.ticket(2)).toMatchObject({ sourceKey: '2', ref: '#2' });
    expect(h.status(2)).toBe('queued');

    expect(h.send({ type: 'retry', workItemId: 1 }).refused).toBe('The work item has not failed.');
    expect(h.send({ type: 'retry', workItemId: 2 }).refused).toBe('The work item has not failed.');
  });

  it('leaves the work item unstarted until Start when not asked to start', () => {
    const h = new Harness();

    expect(h.act({ type: 'adhoc', prompt: 'Write hello.txt', repoRoot: 'D:/scratch' })).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'unstarted', queuedAt: null, runStartedAt: null, taskPrompt: 'Write hello.txt' });

    const start = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

    expect(start).toMatchObject({ workItemId: 1, kind: 'task', cwd: 'D:/scratch', prompt: 'Write hello.txt' });
    expect(h.status(1)).toBe('running');
  });

  it('refuses an empty prompt or no repo', () => {
    const h = new Harness();

    expect(h.send({ type: 'adhoc', prompt: ' \n', repoRoot: 'D:/x' }).refused).toBe('The prompt is empty.');
    expect(h.send({ type: 'adhoc', prompt: 'Hi', repoRoot: '' }).refused).toBe('Choose a repo for the prompt.');
    expect(h.store.tickets('adhoc')).toEqual([]);
  });

  it('fails a start with no repo root configured', () => {
    const h = new Harness();
    h.settings.sources['github']!.repoRoot = '';
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'support:defect');

    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'sources.github.repoRoot is not set.' });
  });
});

describe("a ticket's repository and repo root (PRD R16, R21, R44)", () => {
  function patterned(): Harness {
    const h = new Harness({ playbooks: playbooks(undefined, { 'dev:repo': { description: 'Name the repository', autoStart: true, workdir: 'repoRoot', template: '{{ticket.repo}} {{ticket.number}} {{ticket.ref}} {{ticket.sourceKey}}' } }) });
    h.settings.sources['github'] = { ...h.settings.sources['github']!, repoRoot: 'D:/git/{name}', options: { repo: 'Acme/Widgets' } };
    return h;
  }

  it("starts a home-repository ticket in the pattern's root and fills {{ticket.repo}} and {{ticket.number}}", () => {
    const h = patterned();
    const [triage] = h.poll({ ...issue('18941'), repo: 'acme/widgets' });
    const [start] = h.triaged(triage, 'dev:repo');

    expect(h.store.ticket(1)?.repo).toBe('acme/widgets');
    expect(start).toMatchObject({ type: 'start-session', cwd: 'D:/git/widgets', prompt: expect.stringContaining('acme/widgets 18941 #18941 18941') });
  });

  it('takes the home repository for a ticket stored before the repository was recorded', () => {
    const h = patterned();
    const [triage] = h.poll(issue('18941'));
    const [start] = h.triaged(triage, 'dev:repo');

    expect(h.store.ticket(1)?.repo).toBe('');
    expect(start).toMatchObject({ cwd: 'D:/git/widgets', prompt: expect.stringContaining('acme/widgets 18941 ') });
  });

  it("fails a start of another repository's ticket from a root without {name}, with the reason", () => {
    const h = patterned();
    h.settings.sources['github']!.repoRoot = 'D:/git/widgets';
    const [triage] = h.poll({ ...issue('63'), repo: 'acme/widgets-dashboard' });
    h.triaged(triage, 'dev:repo');
    h.act({ type: 'start', workItemId: 1 });

    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'sources.github.repoRoot has no {name}, so acme/widgets-dashboard has no repo root.' });
  });

  it("fails a start whose root is refused even when a worktree is linked, so the worktree cannot stand in for an unknown clone", () => {
    const h = patterned();
    h.settings.sources['github']!.repoRoot = 'D:/git/widgets';
    const [triage] = h.poll({ ...issue('acme/widgets-dashboard#63'), repo: 'acme/widgets-dashboard' });
    h.act({ type: 'worktree-found', source: 'github', sourceKey: 'acme/widgets-dashboard#63', path: 'D:/git/widgets-wt/63-fix', branch: '63-fix' });
    h.triaged(triage, 'dev:develop');

    expect(h.act({ type: 'start', workItemId: 1 })).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'sources.github.repoRoot has no {name}, so acme/widgets-dashboard has no repo root.' });
  });

  it("holds another repository's auto-start work for Start, saying why, and starts it in its own root on Start (PRD R44)", () => {
    const h = patterned();
    const [triage] = h.poll({ ...issue('acme/widgets-dashboard#63'), ref: 'acme/widgets-dashboard#63', repo: 'acme/widgets-dashboard', url: 'https://github.com/acme/widgets-dashboard/issues/63' });

    expect(h.triaged(triage, 'dev:repo')).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'unstarted', error: 'acme/widgets-dashboard is outside the home repository acme/widgets, so it waits for Start.' });
    expect(h.act({ type: 'start', workItemId: 1 })).toEqual([
      expect.objectContaining({ type: 'start-session', cwd: 'D:/git/widgets-dashboard', prompt: expect.stringContaining('acme/widgets-dashboard 63 acme/widgets-dashboard#63 acme/widgets-dashboard#63') }),
    ]);
  });

  it('leaves {{ticket.repo}} and {{ticket.number}} empty for a ticket without a repository', () => {
    const h = new Harness({ playbooks: playbooks(['triage:zoho'], { 'support:repo': { description: 'Name the repository', autoStart: true, workdir: 'repoRoot', template: '[{{ticket.repo}}][{{ticket.number}}]' } }) });
    const [triage] = h.act({ type: 'poll', source: 'zoho', tickets: [{ ...issue('5'), ref: 'T5' }] });
    const [start] = h.triaged(triage, 'support:repo');

    expect(start).toMatchObject({ cwd: 'D:/git/support', prompt: expect.stringContaining('[][]') });
  });

  it("offers a task report the resolved roots and defaults to the ticket's, never a pattern (PRD R68)", () => {
    const h = patterned();
    const [triage] = h.poll({ ...issue('18941'), repo: 'acme/widgets' });
    const session = h.started(h.triaged(triage, 'dev:repo')[0]);

    expect(h.report(session, { kind: 'task', prompt: 'Follow up', repo: 'D:/git/{name}', title: null }).refused).toBe('D:/git/{name} is not a configured repo root. Repo roots: D:/git/widgets, D:/git/support.');
    expect(h.report(session, { kind: 'task', prompt: 'Follow up', repo: null, title: null }).refused).toBeNull();
    expect(h.store.ticket(2)).toMatchObject({ source: 'adhoc', repoRoot: 'D:/git/widgets' });
  });
});

describe('task reports (PRD R68)', () => {
  /** Runs GitHub issue 18941 under dev:question, whose playbook lists no task report. */
  function parent(h: Harness): { item: number; session: string } {
    const [triage] = h.poll(issue('18941'));
    h.triaged(triage, 'dev:question');
    const session = h.started(h.act({ type: 'start', workItemId: 1 })[0]);

    return { item: 1, session };
  }

  it('creates an unstarted ad-hoc work item in the reporting ticket repo, titled by the first line, and Start runs the prompt there', () => {
    const h = new Harness();
    const { item, session } = parent(h);
    const prompt = '  Fix the flaky CartTests\nin D:/git/widgets/Test/CartTests.cs';

    h.now += MINUTE;
    expect(h.report(session, { kind: 'task', prompt, repo: null, title: null })).toEqual({ actions: [], refused: null });
    expect(h.store.ticket(2)).toMatchObject({ source: 'adhoc', sourceKey: '1', ref: '#1', repo: '', title: 'Fix the flaky CartTests', url: '', assigned: true, repoRoot: 'D:/git/widgets', scopeAt: T0 + MINUTE });
    expect(h.item(2)).toMatchObject({ ticketId: 2, playbook: null, status: 'unstarted', taskPrompt: prompt, parentId: item, queuedAt: null, runStartedAt: null, statusAt: T0 + MINUTE });
    expect(h.item(item)).toMatchObject({ status: 'running', parentId: null });

    const start = only(h.act({ type: 'start', workItemId: 2 }), 'start-session');

    expect(start).toEqual({
      type: 'start-session',
      provider: 'claude',
      sessionId: 's2',
      workItemId: 2,
      kind: 'task',
      cwd: 'D:/git/widgets',
      prompt,
      contract: CONTRACT('s2', ['stage', 'worktree', 'done', 'approval', 'link', 'paste', 'task']),
      name: 'switchboard · ad-hoc · adhoc 1',
      permissionMode: 'auto',
      model: null,
      codeMode: true,
      withoutCodeMode: true,
      nativeSessionId: expect.any(String) as unknown as string,
      launchId: expect.any(String) as unknown as string,
    });
    expect(h.item(2)).toMatchObject({ status: 'running', runStartedAt: T0 + MINUTE });
  });

  it('takes a configured repo in any spelling and a title, adds nothing for a repeat while the first is open, and accepts a report after the parent is done', () => {
    const h = new Harness();
    const { item, session } = parent(h);
    const report = { kind: 'task', prompt: 'Write the support runbook', repo: 'd:\\GIT\\support\\', title: ' Runbook ' } as const;

    h.report(session, report);
    expect(h.store.ticket(2)).toMatchObject({ title: 'Runbook', repoRoot: 'D:/git/support' });

    h.report(session, report);
    expect(h.store.tickets('adhoc')).toHaveLength(1);

    h.act({ type: 'mark-done', workItemId: 2 });
    h.act({ type: 'mark-done', workItemId: item });
    h.report(session, { ...report, title: '' });
    expect(h.store.ticket(3)).toMatchObject({ title: 'Write the support runbook', repoRoot: 'D:/git/support' });
    expect(h.item(3)).toMatchObject({ status: 'unstarted', parentId: item });
  });

  it('refuses an empty prompt and a repo that is not a configured repo root', () => {
    const h = new Harness();
    const { session } = parent(h);

    expect(h.report(session, { kind: 'task', prompt: ' \n ', repo: null, title: 'x' }).refused).toBe('The prompt is empty.');
    expect(h.report(session, { kind: 'task', prompt: 'Do it', repo: 'D:/git/other', title: null }).refused).toBe('D:/git/other is not a configured repo root. Repo roots: D:/git/widgets, D:/git/support.');

    h.settings.sources['github']!.repoRoot = '';
    expect(h.report(session, { kind: 'task', prompt: 'Do it', repo: null, title: null }).refused).toBe('Name a repo with --repo. Repo roots: D:/git/support.');
    expect(h.store.tickets('adhoc')).toEqual([]);
  });
});

describe('registered sessions (PRD R81)', () => {
  const NATIVE = '9273f594-1111-4222-8333-444455556666';
  const register = (h: Harness, title = ' Fix the badge ') => h.send({ type: 'register', nativeSessionId: NATIVE, shortId: '9273f594', cwd: 'D:/git/widgets.worktrees/18941', title });

  it('creates a running ad-hoc work item in the session directory, whose session is released, external and offered the ad-hoc reports', () => {
    const h = new Harness();

    expect(register(h)).toEqual({ actions: [], refused: null });
    expect(h.store.ticket(1)).toMatchObject({ source: 'adhoc', sourceKey: '1', ref: '#1', repo: '', title: 'Fix the badge', url: '', assigned: true, repoRoot: 'D:/git/widgets.worktrees/18941', scopeAt: T0 });
    expect(h.item(1)).toMatchObject({ ticketId: 1, playbook: null, status: 'running', taskPrompt: null, queuedAt: null, runStartedAt: T0, statusAt: T0, parentId: null });
    expect(h.store.sessionsFor(1)).toEqual([
      expect.objectContaining({ id: 's1', kind: 'task', provider: 'claude', nativeSessionId: NATIVE, shortId: '9273f594', cwd: 'D:/git/widgets.worktrees/18941', state: 'running', released: true, releasing: false, external: true, reports: ['stage', 'worktree', 'done', 'approval', 'link', 'paste', 'task'] }),
    ]);
    expect(h.store.ticketHistory(1)!.events.map((event) => [event.type, event.actor, event.detail])).toEqual([['register', 'operator', { cwd: 'D:/git/widgets.worktrees/18941' }]]);
  });

  it('ends a turn without a done report as an ad-hoc session does, with no release stop, and stays external until its process ends', () => {
    const h = new Harness();
    register(h);

    expect(h.act({ type: 'roster', sessions: [{ sessionId: 's1', state: 'idle', detail: null, interactive: true }] })).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.turnEnded });
    expect(h.store.session('s1')).toMatchObject({ state: 'idle', external: true });

    h.act({ type: 'roster', sessions: [] });
    expect(h.store.session('s1')).toMatchObject({ state: 'ended', external: false });
  });

  it('becomes a held session, without Code Mode when it ran without it, once its resume in the holder starts (PRD R81, R95)', () => {
    const h = new Harness();
    register(h);
    expect(h.store.session('s1')).toMatchObject({ registered: true, codeMode: false });

    // While it runs in the operator's window, or without an adopting resume, nothing changes.
    h.act({ type: 'held-resuming', sessionId: 's1', launchId: 'l1', adopt: { codeMode: false } });
    expect(h.store.session('s1')).toMatchObject({ codeMode: false, launchId: null });

    h.act({ type: 'roster', sessions: [] });
    expect(resumesHeld(h.store.session('s1')!)).toBe(true);
    h.act({ type: 'held-resuming', sessionId: 's1', launchId: 'l1' });
    expect(h.store.session('s1')).toMatchObject({ codeMode: false, launchId: null });

    h.act({ type: 'held-resuming', sessionId: 's1', launchId: 'l2', adopt: { codeMode: false } });
    expect(h.store.session('s1')).toMatchObject({ state: 'ended', codeMode: true, withoutCodeMode: true, launchId: 'l2' });
    expect(resumesHeld(h.store.session('s1')!)).toBe(false);

    h.act({ type: 'held-resumed', sessionId: 's1', launchId: 'l2' });
    expect(h.store.session('s1')).toMatchObject({ state: 'idle', released: false, endedAt: null, launchId: 'l2' });
  });

  it('becomes a Code Mode held session when it ran in Code Mode, a background session from an earlier hub adopts too, and a Codex session never does', () => {
    const h = new Harness();
    register(h);
    h.act({ type: 'roster', sessions: [] });

    h.act({ type: 'held-resuming', sessionId: 's1', launchId: 'l1', adopt: { codeMode: true } });
    expect(h.store.session('s1')).toMatchObject({ codeMode: true, withoutCodeMode: false, launchId: 'l1' });

    h.store.updateSession('s1', { registered: false, codeMode: false });
    h.act({ type: 'held-resuming', sessionId: 's1', launchId: 'l2', adopt: { codeMode: false } });
    expect(h.store.session('s1')).toMatchObject({ codeMode: true, withoutCodeMode: true, launchId: 'l2' });

    h.store.updateSession('s1', { codeMode: false, provider: 'codex' });
    h.act({ type: 'held-resuming', sessionId: 's1', launchId: 'l3', adopt: { codeMode: true } });
    expect(h.store.session('s1')).toMatchObject({ codeMode: false, launchId: 'l2' });
  });

  it('refuses Stop, because the session runs in the operator window', () => {
    const h = new Harness();
    register(h);

    expect(h.send({ type: 'stop', workItemId: 1 })).toEqual({ actions: [], refused: 'The session runs in your own window; stop it there.' });
  });

  it('is done by its done report', () => {
    const h = new Harness();
    register(h);

    expect(h.report('s1', { kind: 'done' }).refused).toBeNull();
    expect(h.item(1)).toMatchObject({ status: 'done', doneReason: 'session' });
  });

  it('refuses an empty title, a session already registered, and a copy a fork retired', () => {
    const h = new Harness();

    expect(register(h, ' ').refused).toBe('The title is empty.');
    expect(h.store.tickets('adhoc')).toEqual([]);

    register(h);
    expect(register(h).refused).toBe('This session is already in Switchboard as adhoc 1.');

    h.store.updateSession('s1', { nativeSessionId: 'aa2285b2-0000-4000-8000-000000000000', retiredIds: [NATIVE] });
    expect(register(h).refused).toBe('This session is already in Switchboard as adhoc 1.');
    expect(h.store.tickets('adhoc')).toHaveLength(1);
  });
});

describe('ticket reports (PRD R83)', () => {
  const NATIVE = '9273f594-1111-4222-8333-444455556666';
  const URL = 'https://github.com/acme/widgets/issues/115';
  const AD_HOC_REPORTS = ['stage', 'worktree', 'done', 'approval', 'link', 'paste', 'task'];
  const register = (h: Harness) => h.send({ type: 'register', nativeSessionId: NATIVE, shortId: '9273f594', cwd: 'D:/git/widgets.worktrees/115', title: 'Explore snapshots' });
  const move = (h: Harness, playbook: string | null = 'dev:develop', sessionId = 's1') => h.send({ type: 'ticket', sessionId, source: 'github', sourceKey: '115', ref: '#115', repo: '', title: 'Issue 115', url: URL, playbook });
  const harness = () => {
    const h = new Harness();
    h.settings.sources['github']!.namespace = 'dev';
    return h;
  };
  /** The ad-hoc ticket as it stands, to show a refusal changed nothing. */
  const unmoved = { source: 'adhoc', sourceKey: '1', ref: '#1', repo: '', title: 'Explore snapshots', url: '', assigned: true, adhocKey: null };

  it("moves a registered session's work item onto the issue in place, out of the assigned state, and gives the session the playbook's reports", () => {
    const h = harness();
    register(h);

    expect(move(h)).toEqual({ actions: [], refused: null });
    expect(h.store.ticket(1)).toMatchObject({ source: 'github', sourceKey: '115', ref: '#115', repo: '', sourceId: null, title: 'Issue 115', url: URL, assigned: false, pool: false, repoRoot: 'D:/git/widgets.worktrees/115', adhocKey: '1', scopeAt: T0 });
    expect(h.store.findTicket('adhoc', '1')).toBeNull();
    expect(h.item(1)).toMatchObject({ ticketId: 1, playbook: 'dev:develop', status: 'running' });
    expect(h.store.session('s1')!.reports).toEqual(FINISHING_REPORTS);
    expect(h.store.ticketHistory(1)!.events.map((event) => [event.type, event.actor, event.detail])).toEqual([
      ['register', 'operator', { cwd: 'D:/git/widgets.worktrees/115' }],
      ['ticket', 'session', { source: 'github', sourceKey: '115', playbook: 'dev:develop', adhocKey: '1' }],
    ]);
  });

  it('creates no second work item when the issue enters the assigned state, and a retry changes nothing', () => {
    const h = harness();
    register(h);
    move(h);

    expect(h.poll(issue('115'))).toEqual([]);
    expect(h.store.ticket(1)).toMatchObject({ assigned: true, adhocKey: '1' });
    expect(h.store.workItemsForTicket(1)).toHaveLength(1);
    expect(move(h, 'dev:question')).toEqual({ actions: [], refused: null });
    expect(h.store.workItemsForTicket(1)).toHaveLength(1);
    expect(h.store.ticket(1)).toMatchObject({ source: 'github', sourceKey: '115', assigned: true, adhocKey: '1' });
    expect(h.item(1)).toMatchObject({ playbook: 'dev:develop' });
    expect(h.store.session('s1')!.reports).toEqual(FINISHING_REPORTS);
  });

  it("keeps a started session's reports, because its contract is in its system prompt, and keeps the ad-hoc work item unplaybooked without --playbook", () => {
    const h = harness();
    h.act({ type: 'adhoc', prompt: 'Explore snapshots', repoRoot: 'D:/git/widgets', start: true });

    expect(move(h).refused).toBeNull();
    expect(h.item(1)).toMatchObject({ playbook: 'dev:develop', taskPrompt: 'Explore snapshots' });
    expect(h.store.session('s1')!.reports).toEqual(AD_HOC_REPORTS);

    const g = harness();
    register(g);
    expect(move(g, null).refused).toBeNull();
    expect(g.item(1)).toMatchObject({ playbook: null });
    expect(g.store.session('s1')!.reports).toEqual(AD_HOC_REPORTS);
  });

  it('takes the place of a ticket a poll stored with nothing on it, and refuses one with a work item', () => {
    const h = harness();
    // The issue is assigned on a status outside scope, so the poll stores a ticket with no work item.
    h.poll(issue('115', false));
    register(h);

    expect(move(h).refused).toBeNull();
    expect(h.store.findTicket('github', '115')).toMatchObject({ id: 2, adhocKey: '1' });
    expect(h.store.ticket(1)).toBeNull();

    const g = harness();
    g.poll(issue('115'));
    register(g);
    expect(move(g).refused).toBe('Switchboard already has github 115.');
    expect(g.store.ticket(2)).toMatchObject(unmoved);
  });

  it('refuses an unknown playbook, one outside the namespace, a work item that is not ad-hoc, a done one, and an earlier session, changing nothing', () => {
    const h = harness();
    register(h);

    expect(move(h, 'dev:gone').refused).toBe('dev:gone is not a task playbook in the dev namespace.');
    expect(move(h, 'support:defect').refused).toBe('support:defect is not a task playbook in the dev namespace.');
    expect(move(h, 'triage:github').refused).toBe('triage:github is not a task playbook in the dev namespace.');
    expect(h.store.ticket(1)).toMatchObject(unmoved);
    expect(h.store.session('s1')!.reports).toEqual(AD_HOC_REPORTS);

    h.report('s1', { kind: 'done' });
    expect(move(h).refused).toBe('The work item is done.');

    const g = harness();
    const [triage] = g.poll(issue('20'));
    g.triaged(triage, 'dev:question');
    const session = g.started(g.act({ type: 'start', workItemId: 1 })[0]);
    expect(move(g, null, session).refused).toBe('Only an ad-hoc or registered work item can move to a ticket.');

    const k = harness();
    const first = k.started(only(k.act({ type: 'adhoc', prompt: 'Explore snapshots', repoRoot: 'D:/git/widgets', start: true }), 'start-session'));
    // Approve starts a second session, the work item's latest.
    k.report(first, { kind: 'approval', prompt: '/ship', summary: null, report: null });
    k.act({ type: 'marker', sessionId: first, state: 'idle', detail: null });
    k.act({ type: 'stop-succeeded', sessionId: first, reason: 'release' });
    k.started(only(k.act({ type: 'approve', workItemId: 1 }), 'start-session'));
    expect(k.store.sessionsFor(1)).toHaveLength(2);
    expect(move(k, null, first).refused).toBe("Only the work item's latest session can move it to a ticket.");
  });

  it('never gives a moved ad-hoc key to a new ad-hoc ticket', () => {
    const h = harness();
    register(h);
    move(h);
    h.act({ type: 'adhoc', prompt: 'Second', repoRoot: 'D:/git/widgets' });

    expect(h.store.ticket(2)).toMatchObject({ source: 'adhoc', sourceKey: '2' });
  });
});

describe('in-queue times (PRD R27)', () => {
  const entered = (key: string, enteredAt: number | null, assigned = true): PolledTicket => ({ ...issue(key, assigned), enteredAt });

  it("takes the source's scope entry whenever it has one, even across a status outside the assigned ones", () => {
    const h = new Harness();
    h.poll(entered('1', T0 - 5_000), entered('2', T0 - 1_000, false));
    expect(['1', '2'].map((key) => h.store.findTicket('github', key)?.scopeAt)).toEqual([T0 - 5_000, T0 - 1_000]);

    // Out of the assigned statuses and back with the same assignment: the clock does not restart.
    h.now = T0 + 1_000;
    h.poll(entered('1', T0 - 5_000, false), entered('2', T0 - 1_000));
    h.now = T0 + 2_000;
    h.poll(entered('1', T0 - 5_000), entered('2', T0 - 1_000));
    expect(['1', '2'].map((key) => h.store.findTicket('github', key)?.scopeAt)).toEqual([T0 - 5_000, T0 - 1_000]);

    // A new assignment moves it.
    h.now = T0 + 3_000;
    h.poll(entered('1', T0 + 2_500), entered('2', T0 - 1_000));
    expect(h.store.findTicket('github', '1')?.scopeAt).toBe(T0 + 2_500);
  });

  it("without a source time, takes the poll's time once and keeps it, also across a status outside the assigned ones", () => {
    const h = new Harness();
    h.poll(entered('1', null), entered('2', null, false));
    expect(['1', '2'].map((key) => h.store.findTicket('github', key)?.scopeAt)).toEqual([T0, null]);

    h.now = T0 + 1_000;
    h.poll(entered('1', null, false), entered('2', null));
    h.now = T0 + 2_000;
    h.poll(entered('1', null), entered('2', null));
    expect(['1', '2'].map((key) => h.store.findTicket('github', key)?.scopeAt)).toEqual([T0, T0 + 1_000]);
  });

  it('keeps the scope entry on a work item when it is done, so a later return does not move it', () => {
    const h = new Harness();
    h.poll(entered('1', T0 - 5_000));
    h.now = T0 + 1_000;
    h.act({ type: 'mark-done', workItemId: 1 });
    h.poll();
    expect(h.item(1)).toMatchObject({ status: 'done', scopeAt: T0 - 5_000, doneAt: T0 + 1_000 });

    h.now = T0 + 2_000;
    h.poll(entered('1', T0 + 1_500));
    expect(h.store.findTicket('github', '1')?.scopeAt).toBe(T0 + 1_500);
    expect(h.item(1).scopeAt).toBe(T0 - 5_000);

    // A ticket with no scope entry, such as one done before migration 6 polled it, keeps the work item's creation.
    const g = new Harness();
    g.store.insertTicket({ source: 'github', sourceKey: '9', ref: '#9', repo: '', sourceId: null, title: 't', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
    g.store.insertWorkItem({ ...h.item(1), ticketId: 1, status: 'unstarted', createdAt: T0 - 7_000, scopeAt: null, doneAt: null, doneReason: null });
    g.now = T0 + 9_000;
    g.act({ type: 'mark-done', workItemId: 1 });
    expect(g.item(1)).toMatchObject({ status: 'done', scopeAt: T0 - 7_000 });
  });

  it('moves statusAt on each status change, and runStartedAt only when a run starts from another status', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    expect(h.item(1)).toMatchObject({ status: 'triaging', statusAt: T0, runStartedAt: T0 });

    h.now = T0 + 1_000;
    h.triaged(triage, 'dev:question');
    expect(h.item(1)).toMatchObject({ status: 'unstarted', statusAt: T0 + 1_000, runStartedAt: T0 });

    h.now = T0 + 2_000;
    const session = h.started(h.act({ type: 'start', workItemId: 1 })[0]);
    expect(h.item(1)).toMatchObject({ status: 'running', statusAt: T0 + 2_000, runStartedAt: T0 + 2_000 });

    // A status that stays the same keeps its time.
    h.now = T0 + 3_000;
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.item(1)).toMatchObject({ statusAt: T0 + 2_000, runStartedAt: T0 + 2_000 });

    h.now = T0 + 4_000;
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(1)).toMatchObject({ status: 'blocked', statusAt: T0 + 4_000, runStartedAt: T0 + 2_000 });

    h.now = T0 + 5_000;
    h.act({ type: 'roster', sessions: [] });
    h.store.updateWorkItem(1, { status: 'failed', error: 'The start failed.' });
    h.act({ type: 'retry', workItemId: 1 });
    expect(h.item(1)).toMatchObject({ status: 'running', statusAt: T0 + 5_000, runStartedAt: T0 + 5_000 });
  });

  it('starts the run clock when a queued work item starts, not when it was queued', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'));
    h.started(only(h.triaged(triages[0], 'support:defect'), 'start-session'));
    h.triaged(triages[1], 'support:defect');
    expect(h.status(2)).toBe('queued');

    h.now = T0 + 9_000;
    only(h.act({ type: 'roster', sessions: [] }), 'start-session');
    expect(h.item(2)).toMatchObject({ status: 'running', runStartedAt: T0 + 9_000 });
  });
});

describe('agents (PRD R22)', () => {
  it("runs a Codex playbook's sessions in Codex, with Codex's defaults and contract, and its stops name Codex", () => {
    const h = new Harness({ settings: settings({ sessions: { codex: { permissionMode: 'dontAsk', model: 'gpt-6' } } }), playbooks: playbooks(['triage:github'], { 'dev:codex': { description: 'Build it in Codex', provider: 'codex', template: '/sb-plan {{ticket.sourceKey}}' } }) });
    const [triage] = h.poll(issue('1'));

    h.triaged(triage, 'dev:codex');
    const start = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

    expect(start).toMatchObject({ provider: 'codex', permissionMode: 'dontAsk', model: 'gpt-6', prompt: '/sb-plan 1' });
    expect(start.contract).toContain('report question s1 --text <question>');
    expect(start.contract).not.toContain('AskUserQuestion');
    expect(h.store.session('s1')).toMatchObject({ provider: 'codex' });

    h.started(start);
    expect(h.act({ type: 'stop', workItemId: 1 })).toEqual([{ type: 'stop-session', sessionId: 's1', provider: 'codex', shortId: 'abc12345', reason: 'operator', execution: 'app-server' }]);
  });

  it("takes sessions.provider for a playbook that names none and for an ad-hoc prompt, and a playbook's own mode and model over the provider's", () => {
    const h = new Harness({ settings: settings({ sessions: { provider: 'codex' } }), playbooks: playbooks(['triage:github', 'dev:question']) });

    const adhoc = only(h.act({ type: 'adhoc', prompt: 'Fix it', repoRoot: 'D:/git/widgets', start: true }), 'start-session');

    expect(adhoc).toMatchObject({ provider: 'codex', permissionMode: 'auto', model: null });

    const [triage] = h.poll(issue('2'));

    h.triaged(triage, 'dev:question');
    expect(only(h.act({ type: 'start', workItemId: 2 }), 'start-session')).toMatchObject({ provider: 'codex', permissionMode: 'plan', model: 'opus' });
  });

  it("runs a Codex playbook's setup session in Codex too, and a Claude playbook stays in Claude when the default is Codex", () => {
    const h = new Harness({
      settings: settings({ sessions: { provider: 'codex' } }),
      playbooks: playbooks(['triage:github'], {
        'dev:build': { description: 'Build', provider: 'codex', autoStart: true, requiresWorktree: true, template: 'Build.' },
        'dev:claude': { description: 'Claude work', provider: 'claude', autoStart: true, template: 'Work.' },
      }),
    });
    const [first, second] = h.poll(issue('1'), issue('2'));

    expect(only(h.triaged(first, 'dev:build'), 'start-session')).toMatchObject({ kind: 'setup', provider: 'codex', prompt: '/init-worktree 1' });
    expect(only(h.triaged(second, 'dev:claude'), 'start-session')).toMatchObject({ kind: 'task', provider: 'claude', permissionMode: 'auto' });
  });
});

describe('release in progress (PRD R39)', () => {
  it('lets the operator stop or delete a held session whose idle end failed', () => {
    const h = new Harness();
    const [first, second] = h.poll(issue('1'), issue('2'));
    const one = h.started(only(h.triaged(first, 'support:defect'), 'start-session'), 'abc00001');
    const two = h.started(only(h.triaged(second, 'support:defect'), 'start-session'), 'abc00002');

    for (const session of [one, two]) {
      h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
      h.act({ type: 'held-idle', sessionId: session });
      h.act({ type: 'stop-failed', sessionId: session, reason: 'release', message: 'busy' });
      expect(h.store.session(session)).toMatchObject({ state: 'idle', released: false, releasing: false });
    }

    expect(h.act({ type: 'stop', workItemId: 1 })).toEqual([{ type: 'stop-session', sessionId: one, provider: 'claude', shortId: 'abc00001', reason: 'operator', codeMode: true }]);
    h.act({ type: 'stop-succeeded', sessionId: one, reason: 'operator' });
    expect(h.store.session(one)).toMatchObject({ state: 'ended', releasing: false });
    expect(h.act({ type: 'delete', workItemId: 2 })).toEqual([{ type: 'stop-session', sessionId: two, provider: 'claude', shortId: 'abc00002', reason: 'operator', codeMode: true }]);
  });

  it('clears releasing when the release stop succeeds', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const session = h.started(only(h.triaged(triage, 'support:defect'), 'start-session'));

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' });
    expect(h.store.session(session)).toMatchObject({ state: 'ended', releasing: false });
  });
});
