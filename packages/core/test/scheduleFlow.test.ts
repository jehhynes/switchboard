import { describe, expect, it } from 'vitest';
import type { ScheduleSettings } from '../src/settings.js';
import { Harness, MINUTE, playbooks, settings } from './flowHarness.js';

// Local times, because schedules run at their time where the operator is. Thursday 15 October 2026.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

const OPS = {
  'ops:cleanup': { description: 'Remove finished worktrees', autoStart: true, workdir: 'repoRoot', reports: ['done'], template: '/cleanup-worktrees' },
  'ops:review': { description: 'Measure review outcomes', reports: ['done'], template: '/performance-self-review' },
};

const WEEKLY: ScheduleSettings = { playbook: 'ops:cleanup', repoRoot: 'D:/git/widgets', every: 'week', day: 'fri', at: 12 * 60 };

function harness(schedules: Record<string, ScheduleSettings> = { cleanup: WEEKLY }): Harness {
  const h = new Harness({ settings: settings({ schedules }), playbooks: playbooks(undefined, OPS) });

  h.now = at(15, 10);
  return h;
}

function tick(h: Harness, time: number) {
  h.now = time;
  return h.act({ type: 'tick' });
}

const ticket = (h: Harness, name = 'cleanup') => h.store.findTicket('schedule', name)!;
const items = (h: Harness, name = 'cleanup') => h.store.workItemsForTicket(ticket(h, name).id);

describe('schedules (PRD R82)', () => {
  it('makes a ticket for each schedule, titled by its playbook, and no run for a time before it first saw the schedule', () => {
    const h = harness({ cleanup: WEEKLY, review: { playbook: 'ops:review', repoRoot: 'D:/git/research', every: null, day: null, at: null } });

    tick(h, at(15, 10));

    expect(ticket(h)).toMatchObject({ source: 'schedule', sourceKey: 'cleanup', ref: 'cleanup', title: 'Remove finished worktrees', url: '', assigned: true, repoRoot: 'D:/git/widgets', lastPolledAt: at(15, 10) });
    expect(ticket(h, 'review')).toMatchObject({ title: 'Measure review outcomes', repoRoot: 'D:/git/research' });
    expect(items(h)).toEqual([]);
  });

  it('queues a run of a playbook that starts automatically at the tick after its time, in the schedule repo root', () => {
    const h = harness();
    tick(h, at(15, 10));

    expect(tick(h, at(16, 11, 59))).toEqual([]);

    const actions = tick(h, at(16, 12, 0));

    expect(items(h)).toMatchObject([{ playbook: 'ops:cleanup', status: 'running', taskPrompt: expect.stringContaining('/cleanup-worktrees') }]);
    expect(actions).toMatchObject([{ type: 'start-session', kind: 'task', cwd: 'D:/git/widgets', name: 'switchboard · ops:cleanup · schedule cleanup', prompt: expect.stringMatching(/^\/cleanup-worktrees/) }]);
    expect(ticket(h).scopeAt).toBe(at(16, 12));
  });

  it('leaves a run of a playbook that does not start automatically unstarted', () => {
    const h = harness({ review: { playbook: 'ops:review', repoRoot: 'D:/git/research', every: 'day', day: null, at: 9 * 60 } });
    tick(h, at(15, 8));

    expect(tick(h, at(15, 9, 1))).toEqual([]);
    expect(items(h, 'review')).toMatchObject([{ playbook: 'ops:review', status: 'unstarted', queuedAt: null }]);
  });

  it('runs once for every time that passed while the hub was stopped', () => {
    const h = harness({ review: { playbook: 'ops:review', repoRoot: 'D:/git/research', every: 'day', day: null, at: 9 * 60 } });
    tick(h, at(12, 8));

    tick(h, at(15, 10));

    expect(items(h, 'review')).toHaveLength(1);
    expect(h.store.ticketHistory(ticket(h, 'review').id)!.events.find((event) => event.detail?.['dueAt'] !== undefined)).toMatchObject({ type: 'schedule', actor: 'hub', detail: { name: 'review', dueAt: at(15, 9), skipped: false } });
  });

  it('makes no run while an earlier run is open and logs the skipped time, then runs again once it is done', () => {
    const h = harness();
    tick(h, at(15, 10));
    const [start] = tick(h, at(16, 12));
    const session = h.started(start);

    tick(h, at(23, 12));

    expect(items(h)).toHaveLength(1);
    expect(h.store.ticketHistory(ticket(h).id)!.events.filter((event) => event.detail?.['dueAt'] !== undefined).map((event) => event.detail)).toEqual([
      { name: 'cleanup', dueAt: at(16, 12), skipped: false },
      { name: 'cleanup', dueAt: at(23, 12), skipped: true },
    ]);

    h.report(session, { kind: 'done' });
    h.act({ type: 'roster', sessions: [] });
    expect(h.status(1)).toBe('done');

    tick(h, at(29, 12));
    expect(items(h)).toHaveLength(1);
    tick(h, at(30, 12));
    expect(items(h).map((item) => item.status)).toEqual(['done', 'running']);
  });

  it('does not run a time a settings change moved to between the last check and now, and runs the moved time after that', () => {
    const h = harness();
    tick(h, at(16, 12) + 30_000);
    h.settings = settings({ schedules: { cleanup: { ...WEEKLY, at: 13 * 60 } } });
    tick(h, at(16, 12, 1));
    h.settings = settings({ schedules: { cleanup: { ...WEEKLY, at: 12 * 60 + 2 } } });

    tick(h, at(16, 12, 3));
    expect(items(h)).toEqual([]);
    expect(ticket(h).sourceId).toBe('every week on fri at 12:02');

    tick(h, at(23, 12, 2));
    expect(items(h)).toHaveLength(1);
  });

  it('starts a schedule added again from when it returns, without catching up on the times it was gone', () => {
    const h = harness();
    tick(h, at(15, 10));
    h.settings = settings();
    tick(h, at(15, 11));

    expect(ticket(h).sourceId).toBeNull();

    h.settings = settings({ schedules: { cleanup: WEEKLY } });
    tick(h, at(23, 13));

    expect(items(h)).toEqual([]);
    expect(h.store.ticketHistory(ticket(h).id)!.events.filter((event) => event.type === 'schedule').map((event) => event.changes.map((change) => change.fields['sourceId']).filter(Boolean))).toEqual([
      [[null, 'every week on fri at 12:00']],
      [['every week on fri at 12:00', null]],
      [[null, 'every week on fri at 12:00']],
    ]);
  });

  it('does not run a time that passed before a settings change moved it', () => {
    const h = harness();
    tick(h, at(16, 12, 30));
    h.settings = settings({ schedules: { cleanup: { ...WEEKLY, at: 12 * 60 + 15 } } });

    tick(h, at(16, 12, 31));

    expect(items(h)).toEqual([]);
  });

  it('runs a schedule by hand with Run now, whatever its playbook says, and refuses while a run is open', () => {
    const h = harness({ review: { playbook: 'ops:review', repoRoot: 'D:/git/research', every: null, day: null, at: null } });

    const actions = h.act({ type: 'run-schedule', name: 'review' });

    expect(actions).toMatchObject([{ type: 'start-session', cwd: 'D:/git/research' }]);
    expect(items(h, 'review')).toMatchObject([{ playbook: 'ops:review', status: 'running' }]);
    expect(h.send({ type: 'run-schedule', name: 'review' }).refused).toBe('review already has an open work item.');
    expect(h.send({ type: 'run-schedule', name: 'nightly' }).refused).toBe('settings.json has no schedule named nightly.');
    expect(h.store.ticketHistory(ticket(h, 'review').id)!.events.map((event) => `${event.type}/${event.actor}`)).toEqual(['run-schedule/operator', 'run-schedule/operator']);
  });

  it('fails a run whose playbook is missing or is a triage playbook, naming the cause', () => {
    const h = harness({ gone: { ...WEEKLY, playbook: 'ops:gone' }, triage: { ...WEEKLY, playbook: 'triage:github' } });
    tick(h, at(15, 10));

    tick(h, at(16, 12));

    expect(items(h, 'gone')).toMatchObject([{ status: 'failed', error: 'Playbook ops:gone is not loaded.' }]);
    expect(items(h, 'triage')).toMatchObject([{ status: 'failed', error: 'triage:github is not a task playbook.' }]);
    expect(ticket(h, 'gone').title).toBe('gone');

    // Retry does not start a triage playbook as a task.
    expect(h.act({ type: 'retry', workItemId: items(h, 'triage')[0]!.id })).toEqual([]);
    expect(items(h, 'triage')).toMatchObject([{ status: 'failed', error: 'triage:github is not a task playbook.' }]);
  });

  it('fails a run again on Retry until its playbook loads, then starts it', () => {
    const h = harness({ review: { playbook: 'ops:review', repoRoot: 'D:/git/research', every: null, day: null, at: null } });
    h.act({ type: 'run-schedule', name: 'review' });
    h.act({ type: 'mark-done', workItemId: 1 });
    h.act({ type: 'session-start-failed', sessionId: 's1', message: 'Stopped.' });
    h.settings = settings({ schedules: { review: { playbook: 'ops:missing', repoRoot: 'D:/r', every: null, day: null, at: null } } });
    h.act({ type: 'run-schedule', name: 'review' });

    expect(h.item(2)).toMatchObject({ status: 'failed', error: 'Playbook ops:missing is not loaded.' });

    expect(h.act({ type: 'retry', workItemId: 2 })).toEqual([]);
    expect(h.item(2)).toMatchObject({ status: 'failed', error: 'Playbook ops:missing is not loaded.' });

    h.playbooks.set('ops:missing', { ...h.playbooks.get('ops:review')!, name: 'ops:missing' });
    expect(h.act({ type: 'retry', workItemId: 2 })).toMatchObject([{ type: 'start-session', workItemId: 2, kind: 'task' }]);
    expect(h.item(2)).toMatchObject({ status: 'running', playbook: 'ops:missing', error: null });
  });

  it('follows a change of playbook description and repo root on the next tick', () => {
    const h = harness();
    tick(h, at(15, 10));
    h.settings = settings({ schedules: { cleanup: { ...WEEKLY, repoRoot: 'E:/widgets' } } });
    h.playbooks = playbooks(undefined, { ...OPS, 'ops:cleanup': { ...OPS['ops:cleanup'], description: 'Prune worktrees' } });

    tick(h, at(15, 11));

    expect(ticket(h)).toMatchObject({ title: 'Prune worktrees', repoRoot: 'E:/widgets' });
  });

  it('queues a run of a snoozed schedule until the snooze ends', () => {
    const h = harness();
    tick(h, at(15, 10));
    h.act({ type: 'snooze', ticketId: ticket(h).id, until: at(17, 6) });

    expect(tick(h, at(16, 12))).toEqual([]);
    expect(items(h)).toMatchObject([{ status: 'queued' }]);

    h.now = at(17, 6) + MINUTE;
    expect(h.act({ type: 'tick' })).toMatchObject([{ type: 'start-session' }]);
  });
});
