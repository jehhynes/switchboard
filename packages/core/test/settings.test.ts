import { describe, expect, it } from 'vitest';
import { parseSettings } from '../src/settings.js';

describe('parseSettings', () => {
  it('fills defaults for an empty object', () => {
    expect(parseSettings('{}')).toEqual({
      settings: {
        sessions: { provider: 'claude', concurrency: 2, permissionMode: 'auto', model: '', codex: { permissionMode: 'bypassPermissions', model: '' }, installHooks: true, debriefs: false },
        triage: { model: '', concurrency: 2, timeoutSeconds: 180 },
        sources: {},
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
});
