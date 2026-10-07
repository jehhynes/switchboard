import { describe, expect, it } from 'vitest';
import { parseSettings } from '../src/settings.js';

describe('parseSettings', () => {
  it('fills defaults for an empty object', () => {
    expect(parseSettings('{}')).toEqual({
      settings: {
        sessions: { concurrency: 2, permissionMode: 'auto', model: '', installHooks: true, debriefs: false },
        triage: { model: '', concurrency: 2, timeoutSeconds: 180 },
        sources: {},
      },
    });
  });

  it('reads every value and passes source-specific keys through', () => {
    const result = parseSettings(
      JSON.stringify({
        sessions: { concurrency: 4, permissionMode: 'acceptEdits', model: 'opus', installHooks: false, debriefs: true },
        triage: { model: 'claude-sonnet-5', concurrency: 1, timeoutSeconds: 60 },
        sources: {
          github: { enabled: true, pollIntervalSeconds: 300, repoRoot: 'D:/git/widgets', triagePlaybook: 'triage:github', setupPrompt: '/init-worktree {{ticket.sourceKey}}', repo: 'acme/widgets', logins: ['work-login'] },
        },
      }),
    );

    expect(result).toEqual({
      settings: {
        sessions: { concurrency: 4, permissionMode: 'acceptEdits', model: 'opus', installHooks: false, debriefs: true },
        triage: { model: 'claude-sonnet-5', concurrency: 1, timeoutSeconds: 60 },
        sources: {
          github: {
            enabled: true,
            pollIntervalSeconds: 300,
            repoRoot: 'D:/git/widgets',
            triagePlaybook: 'triage:github',
            setupPrompt: '/init-worktree {{ticket.sourceKey}}',
            namespace: '',
            options: { repo: 'acme/widgets', logins: ['work-login'] },
          },
        },
      },
    });
  });

  it('defaults a source that sets nothing to disabled', () => {
    expect(parseSettings('{"sources":{"adhoc":{}}}')).toEqual({
      settings: expect.objectContaining({
        sources: { adhoc: { enabled: false, pollIntervalSeconds: 300, repoRoot: '', triagePlaybook: '', setupPrompt: '', namespace: '', options: {} } },
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
        sessions: { concurrency: 5, dailyLimit: 20, permissionMode: 'yolo', model: 3, installHooks: 'yes', other: true },
        triage: { concurrency: 0, timeoutSeconds: 1.5 },
        sources: { github: { enabled: 'true', pollIntervalSeconds: 5 }, zoho: 'on' },
      }),
    );

    expect(result).toEqual({
      errors: [
        'settings.extra is not a setting.',
        'sessions.dailyLimit is not a setting.',
        'sessions.other is not a setting.',
        'sessions.concurrency must be a whole number from 1 to 4.',
        'sessions.permissionMode must be one of acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.',
        'sessions.model must be a string.',
        'sessions.installHooks must be true or false.',
        'triage.concurrency must be a whole number of at least 1.',
        'triage.timeoutSeconds must be a whole number of at least 1.',
        'sources.github.enabled must be true or false.',
        'sources.github.pollIntervalSeconds must be a whole number of at least 10.',
        'sources.zoho must be an object.',
      ],
    });
  });

  it('rejects a section that is not an object', () => {
    expect(parseSettings('{"sessions":[]}')).toEqual({ errors: ['sessions must be an object.'] });
  });
});
