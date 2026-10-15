import { describe, expect, it } from 'vitest';
import { parseSettings } from '../src/settings.js';

describe('parseSettings', () => {
  it('fills defaults for an empty object', () => {
    expect(parseSettings('{}')).toEqual({
      settings: {
        sessions: { provider: 'claude', concurrency: 2, permissionMode: 'auto', model: '', codex: { permissionMode: 'bypassPermissions', model: '' }, installHooks: true, debriefs: false },
        triage: { model: '', concurrency: 2, timeoutSeconds: 180 },
        sources: {},
        schedules: {},
      },
    });
  });

  it('reads every value and passes source-specific keys through', () => {
    const result = parseSettings(
      JSON.stringify({
        sessions: { provider: 'codex', concurrency: 10, permissionMode: 'acceptEdits', model: 'opus', codex: { permissionMode: 'plan', model: 'gpt-6' }, installHooks: false, debriefs: true },
        triage: { model: 'claude-sonnet-5', concurrency: 1, timeoutSeconds: 60 },
        sources: {
          github: { pollIntervalSeconds: 300, repoRoot: 'D:/git/widgets', triagePlaybook: 'triage:github', setupPrompt: '/init-worktree {{ticket.sourceKey}}', repo: 'acme/widgets', logins: ['work-login'] },
        },
      }),
    );

    expect(result).toEqual({
      settings: {
        sessions: { provider: 'codex', concurrency: 10, permissionMode: 'acceptEdits', model: 'opus', codex: { permissionMode: 'plan', model: 'gpt-6' }, installHooks: false, debriefs: true },
        triage: { model: 'claude-sonnet-5', concurrency: 1, timeoutSeconds: 60 },
        sources: {
          github: {
            pollIntervalSeconds: 300,
            repoRoot: 'D:/git/widgets',
            triagePlaybook: 'triage:github',
            setupPrompt: '/init-worktree {{ticket.sourceKey}}',
            namespace: '',
            options: { repo: 'acme/widgets', logins: ['work-login'] },
          },
        },
        schedules: {},
      },
    });
  });

  it('fills defaults for a source that sets nothing', () => {
    expect(parseSettings('{"sources":{"adhoc":{}}}')).toEqual({
      settings: expect.objectContaining({
        sources: { adhoc: { pollIntervalSeconds: 300, repoRoot: '', triagePlaybook: '', setupPrompt: '', namespace: '', options: {} } },
      }),
    });
  });

  it('rejects invalid JSON and a non-object', () => {
    expect(parseSettings('{')).toEqual({ errors: [expect.stringMatching(/^settings\.json is not valid JSON: /)] });
    expect(parseSettings('[]')).toEqual({ errors: ['settings.json must contain an object.'] });
  });

  it('lists every invalid value', () => {
    const result = parseSettings(
      JSON.stringify({
        extra: 1,
        sessions: { provider: 'gemini', concurrency: 11, dailyLimit: 20, permissionMode: 'yolo', model: 3, codex: { permissionMode: 'manual', model: 1, sandbox: 'x' }, installHooks: 'yes', other: true },
        triage: { concurrency: 0, timeoutSeconds: 1.5 },
        sources: { github: { enabled: 'true', pollIntervalSeconds: 5 }, zoho: 'on' },
      }),
    );

    expect(result).toEqual({
      errors: [
        'settings.extra is not a setting.',
        'sessions.dailyLimit is not a setting.',
        'sessions.other is not a setting.',
        'sessions.codex.sandbox is not a setting.',
        'sessions.provider must be one of claude, codex.',
        'sessions.concurrency must be a whole number from 1 to 10.',
        'sessions.permissionMode must be one of acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.',
        'sessions.model must be a string.',
        'sessions.codex.permissionMode must be one of auto, plan, dontAsk, bypassPermissions.',
        'sessions.codex.model must be a string.',
        'sessions.installHooks must be true or false.',
        'triage.concurrency must be a whole number of at least 1.',
        'triage.timeoutSeconds must be a whole number of at least 1.',
        "sources.github.enabled is not a setting; turn a source on and off in the dock's header.",
        'sources.github.pollIntervalSeconds must be a whole number of at least 10.',
        'sources.zoho must be an object.',
      ],
    });
  });

  it('rejects a section that is not an object', () => {
    expect(parseSettings('{"sessions":[]}')).toEqual({ errors: ['sessions must be an object.'] });
    expect(parseSettings('{"sessions":{"codex":"on"}}')).toEqual({ errors: ['sessions.codex must be an object.'] });
    expect(parseSettings('{"playbooks":[]}')).toEqual({ errors: ['playbooks must be an object.'] });
  });

  it('accepts playbooks without reading them, so an invalid playbook does not reject the file', () => {
    expect(parseSettings('{"playbooks":{"dev:x":{"reports":"done"}}}')).toEqual(parseSettings('{}'));
  });

  describe('schedules (PRD R82)', () => {
    const schedules = (entries: Record<string, unknown>) => parseSettings(JSON.stringify({ schedules: entries }));

    it('reads daily, weekly, monthly and by-hand schedules, with the time in minutes after midnight', () => {
      expect(
        schedules({
          daily: { playbook: 'ops:a', repoRoot: 'D:/git/widgets', every: 'day', at: '00:00' },
          weekly: { playbook: 'ops:b', repoRoot: 'D:/git/widgets', every: 'week', day: 'fri', at: '12:30' },
          monthly: { playbook: 'ops:c', repoRoot: 'D:/git/research', every: 'month', day: 31, at: '23:59' },
          'by-hand': { playbook: 'ops:d', repoRoot: 'C:/Users/me/.claude' },
        }),
      ).toEqual({
        settings: expect.objectContaining({
          schedules: {
            daily: { playbook: 'ops:a', repoRoot: 'D:/git/widgets', every: 'day', day: null, at: 0 },
            weekly: { playbook: 'ops:b', repoRoot: 'D:/git/widgets', every: 'week', day: 'fri', at: 750 },
            monthly: { playbook: 'ops:c', repoRoot: 'D:/git/research', every: 'month', day: 31, at: 1439 },
            'by-hand': { playbook: 'ops:d', repoRoot: 'C:/Users/me/.claude', every: null, day: null, at: null },
          },
        }),
      });
    });

    it.each([
      ['a missing playbook and repo root', {}, ['schedules.x.playbook must name a task playbook.', 'schedules.x.repoRoot must be set.']],
      ['an unknown key', { playbook: 'ops:a', repoRoot: 'D:/r', when: 'often' }, ['schedules.x.when is not a setting.']],
      ['an unknown period', { playbook: 'ops:a', repoRoot: 'D:/r', every: 'year', at: '09:00' }, ['schedules.x.every must be one of day, week, month.']],
      ['a weekly schedule without a day', { playbook: 'ops:a', repoRoot: 'D:/r', every: 'week', at: '09:00' }, ['schedules.x.day must be one of mon, tue, wed, thu, fri, sat, sun.']],
      ['a weekly schedule with a day number', { playbook: 'ops:a', repoRoot: 'D:/r', every: 'week', day: 5, at: '09:00' }, ['schedules.x.day must be a string.']],
      ['a weekly schedule with a misspelled day', { playbook: 'ops:a', repoRoot: 'D:/r', every: 'week', day: 'friday', at: '09:00' }, ['schedules.x.day must be one of mon, tue, wed, thu, fri, sat, sun.']],
      ['a monthly schedule without a day', { playbook: 'ops:a', repoRoot: 'D:/r', every: 'month', at: '09:00' }, ['schedules.x.day must be a whole number from 1 to 31.']],
      ['a monthly schedule on day 32', { playbook: 'ops:a', repoRoot: 'D:/r', every: 'month', day: 32, at: '09:00' }, ['schedules.x.day must be a whole number from 1 to 31.']],
      ['a daily schedule with a day', { playbook: 'ops:a', repoRoot: 'D:/r', every: 'day', day: 'mon', at: '09:00' }, ['schedules.x.day applies only to a weekly or monthly schedule.']],
      ['a schedule without a time', { playbook: 'ops:a', repoRoot: 'D:/r', every: 'day' }, ['schedules.x.at must be a time from 00:00 to 23:59, such as 09:00.']],
      ['a time past midnight', { playbook: 'ops:a', repoRoot: 'D:/r', every: 'day', at: '24:00' }, ['schedules.x.at must be a time from 00:00 to 23:59, such as 09:00.']],
      ['a time without a leading zero', { playbook: 'ops:a', repoRoot: 'D:/r', every: 'day', at: '9:00' }, ['schedules.x.at must be a time from 00:00 to 23:59, such as 09:00.']],
      ['a time on a by-hand schedule', { playbook: 'ops:a', repoRoot: 'D:/r', at: '09:00' }, ['schedules.x.at applies only with every.']],
    ])('refuses %s', (_name, entry, errors) => {
      expect(schedules({ x: entry })).toEqual({ errors });
    });

    it('refuses a name that is not lowercase letters, digits and hyphens, and a schedule that is not an object', () => {
      expect(schedules({ 'Self Review': { playbook: 'ops:a', repoRoot: 'D:/r' }, y: 'weekly' })).toEqual({
        errors: ["schedules.Self Review: a schedule's name must be lowercase letters, digits and hyphens.", 'schedules.y must be an object.', 'schedules.y.playbook must name a task playbook.', 'schedules.y.repoRoot must be set.'],
      });
    });
  });
});
