import { describe, expect, it } from 'vitest';
import { parseSettings } from '../src/settings.js';

describe('parseSettings', () => {
  it('fills defaults for an empty object', () => {
    expect(parseSettings('{}')).toEqual({
      settings: {
        sessions: { provider: 'claude', concurrency: 2, permissionMode: 'auto', model: '', claudePath: 'claude', codexPath: 'codex', nodePath: 'node', codex: { permissionMode: 'bypassPermissions', model: '' }, installHooks: true, debriefs: false, codeMode: false },
        triage: { model: '', concurrency: 2, timeoutSeconds: 180 },
        sources: {},
        schedules: {},
        dock: { openVSCode: 'always', openTerminal: 'vscode' },
        voice: { enabled: false, voice: 'marin', style: 'none', speed: 1, expressive: false, expandReplies: false, awayMinutes: 2, needsYouSound: true, outputDevice: null, personas: [], playbookPersonas: {} },
      },
    });
  });

  it('reads every value and passes source-specific keys through', () => {
    const result = parseSettings(
      JSON.stringify({
        sessions: { provider: 'codex', concurrency: 10, permissionMode: 'acceptEdits', model: 'opus', claudePath: '/opt/claude/bin/claude', codexPath: '/opt/codex/bin/codex', nodePath: 'C:/nodejs/node.exe', codex: { permissionMode: 'plan', model: 'gpt-6' }, installHooks: false, debriefs: true, codeMode: true },
        triage: { model: 'claude-sonnet-5', concurrency: 1, timeoutSeconds: 60 },
        sources: {
          github: { pollIntervalSeconds: 300, repoRoot: 'D:/git/widgets', triagePlaybook: 'triage:github', setupPrompt: '/init-worktree {{ticket.sourceKey}}', repo: 'acme/widgets', logins: ['work-login'] },
        },
        dock: { openVSCode: 'review', openTerminal: 'auto' },
        voice: { enabled: true, voice: 'cedar', style: 'pair', speed: 1.25, expressive: true, expandReplies: true, awayMinutes: 5, needsYouSound: false, outputDevice: 'Speakers' },
      }),
    );

    expect(result).toEqual({
      settings: {
        sessions: { provider: 'codex', concurrency: 10, permissionMode: 'acceptEdits', model: 'opus', claudePath: '/opt/claude/bin/claude', codexPath: '/opt/codex/bin/codex', nodePath: 'C:/nodejs/node.exe', codex: { permissionMode: 'plan', model: 'gpt-6' }, installHooks: false, debriefs: true, codeMode: true },
        triage: { model: 'claude-sonnet-5', concurrency: 1, timeoutSeconds: 60 },
        sources: {
          github: {
            kind: 'github',
            pollIntervalSeconds: 300,
            repoRoot: 'D:/git/widgets',
            triagePlaybook: 'triage:github',
            setupPrompt: '/init-worktree {{ticket.sourceKey}}',
            namespace: '',
            options: { repo: 'acme/widgets', logins: ['work-login'] },
          },
        },
        schedules: {},
        dock: { openVSCode: 'review', openTerminal: 'auto' },
        voice: { enabled: true, voice: 'cedar', style: 'pair', speed: 1.25, expressive: true, expandReplies: true, awayMinutes: 5, needsYouSound: false, outputDevice: 'Speakers', personas: [], playbookPersonas: {} },
      },
    });
  });

  it('refuses voice values outside their choices and ranges, and other voice keys', () => {
    expect(parseSettings('{"voice":{"voice":"nova","style":"loud","speed":2,"awayMinutes":0,"outputDevice":"","mic":true}}')).toEqual({
      errors: [
        'voice.mic is not a setting.',
        'voice.voice must be one of marin, cedar, alloy, ash, ballad, coral, echo, sage, shimmer, verse.',
        'voice.style must be one of none, pair, upbeat, deadpan, expressive.',
        'voice.speed must be a number from 0.25 to 1.5.',
        'voice.awayMinutes must be a whole number from 1 to 1440.',
        'voice.outputDevice must be a device name or null.',
      ],
    });
    expect(parseSettings('{"voice":{"enabled":"yes"}}')).toEqual({ errors: ['voice.enabled must be true or false.'] });
    expect(parseSettings('{"voice":{"speed":0.25,"outputDevice":null}}')).toMatchObject({ settings: { voice: { speed: 0.25, outputDevice: null } } });
  });

  it('refuses a dock.openVSCode or dock.openTerminal outside its choices, and other dock keys', () => {
    expect(parseSettings('{"dock":{"openVSCode":"never","width":3}}')).toEqual({ errors: ['dock.width is not a setting.', 'dock.openVSCode must be one of always, review.'] });
    expect(parseSettings('{"dock":{"openTerminal":"native"}}')).toEqual({ errors: ['dock.openTerminal must be one of vscode, app, auto.'] });
    expect(parseSettings('{"dock":"review"}')).toMatchObject({ errors: [expect.stringContaining('dock')] });
  });

  it('fills defaults for a source that sets nothing', () => {
    expect(parseSettings('{"sources":{"adhoc":{}}}')).toEqual({
      settings: expect.objectContaining({
        sources: { adhoc: { kind: 'adhoc', pollIntervalSeconds: 300, repoRoot: '', triagePlaybook: '', setupPrompt: '', namespace: '', options: {} } },
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
        sessions: { provider: 'gemini', concurrency: 11, dailyLimit: 20, permissionMode: 'yolo', model: 3, claudePath: 7, codexPath: '', nodePath: '', codex: { permissionMode: 'manual', model: 1, sandbox: 'x' }, installHooks: 'yes', codeMode: 'on', other: true },
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
        'sessions.claudePath must be a path.',
        'sessions.codexPath must be a path.',
        'sessions.nodePath must be a path.',
        'sessions.codex.permissionMode must be one of auto, plan, dontAsk, bypassPermissions.',
        'sessions.codex.model must be a string.',
        'sessions.installHooks must be true or false.',
        'sessions.codeMode must be true or false.',
        'triage.concurrency must be a whole number of at least 1.',
        'triage.timeoutSeconds must be a whole number of at least 1.',
        "sources.github.enabled is not a setting; turn a source on and off in the dock's header.",
        'sources.github.pollIntervalSeconds must be a whole number of at least 10.',
        'sources.zoho must be an object.',
      ],
    });
  });

  it('takes a sessions.nodePath with forward slashes, and refuses one a shell would split or that is not node', () => {
    const nodePath = (value: string) => parseSettings(JSON.stringify({ sessions: { nodePath: value } }));
    const refused = { errors: ['sessions.nodePath must be a path to node or node.exe with no spaces or shell characters.'] };

    expect(nodePath('C:\\nodejs\\node.exe')).toMatchObject({ settings: { sessions: { nodePath: 'C:/nodejs/node.exe' } } });
    expect(nodePath('/home/me/.nvm/versions/node/v24.18.0/bin/node')).toMatchObject({ settings: { sessions: { nodePath: '/home/me/.nvm/versions/node/v24.18.0/bin/node' } } });
    expect(nodePath('C:/Program Files/nodejs/node.exe')).toEqual(refused);
    expect(nodePath('/opt/node;rm/node')).toEqual(refused);
    expect(nodePath('$HOME/bin/node')).toEqual(refused);
    expect(nodePath('/usr/bin/bun')).toEqual(refused);
    expect(nodePath('/usr/bin/nodejs')).toEqual(refused);
  });

  it('takes a source\'s kind from its name unless it sets one, so one plugin can read several sources (PRD R3)', () => {
    const result = parseSettings(JSON.stringify({ sources: { github: {}, 'widgets-dashboard': { kind: 'github' } } }));
    const sources = 'settings' in result ? result.settings.sources : {};

    expect(sources['github']?.kind).toBe('github');
    expect(sources['widgets-dashboard']).toMatchObject({ kind: 'github', options: {} });
  });

  it("takes {name} and {owner} in a source's repo root once each, {owner} only with {name}, and neither in ad-hoc's or a schedule's (PRD R16)", () => {
    const sources = (repoRoot: string) => parseSettings(JSON.stringify({ sources: { github: { repoRoot } } }));

    expect(sources('D:/git/{owner}/{name}')).toMatchObject({ settings: { sources: { github: { repoRoot: 'D:/git/{owner}/{name}' } } } });
    expect(sources('D:/{name}/{name}')).toEqual({ errors: ['sources.github.repoRoot may hold {name} and {owner} at most once each.'] });
    expect(sources('D:/git/{owner}')).toEqual({ errors: ['sources.github.repoRoot holds {owner} without {name}.'] });
    expect(parseSettings(JSON.stringify({ sources: { adhoc: { repoRoot: 'D:/git/{name}' } } }))).toEqual({ errors: ['sources.adhoc.repoRoot names one folder and cannot hold {name} or {owner}.'] });
    expect(parseSettings(JSON.stringify({ schedules: { nightly: { playbook: 'ops:x', repoRoot: 'D:/{owner}' } } }))).toEqual({ errors: ['schedules.nightly.repoRoot names one folder and cannot hold {name} or {owner}.'] });
  });

  it('rejects a source name that is not lowercase letters, digits and hyphens, or is schedule, and a kind on adhoc', () => {
    expect(parseSettings(JSON.stringify({ sources: { 'Widgets Dashboard': {}, schedule: {}, adhoc: { kind: 'github' }, kindless: { kind: 3 } } }))).toEqual({
      errors: [
        "sources.Widgets Dashboard: a source's name must be lowercase letters, digits and hyphens.",
        'sources.schedule: schedules are set under schedules.',
        'sources.adhoc.kind is not a setting; adhoc holds only the ad-hoc repo root.',
        'sources.kindless.kind must be a string.',
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
