import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSettings, fileVersion, loadConfig, readConfigFile, saveSettings, sourceOptionsError } from '../src/config.js';
import { tempHome } from './helpers.js';

let temp: ReturnType<typeof tempHome>;

beforeEach(() => {
  temp = tempHome();
});

afterEach(() => {
  temp.remove();
});

const configDir = () => join(temp.home, '.switchboard');
const settingsFile = () => join(temp.home, '.switchboard', 'settings.json');

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

const GITHUB = { repo: 'o/r', logins: ['me'], project: { owner: 'o', number: 3 }, assignedStatuses: ['Dev'] };

const TASK = { description: 'Develop it', requiresWorktree: true, template: '/gc-plan {{ticket.sourceKey}}' };

describe('checkSettings', () => {
  it('passes valid settings, and a disabled source whose own keys are incomplete', () => {
    expect(checkSettings({ sessions: { concurrency: 3 }, sources: { github: GITHUB, zoho: {} } }, new Set(['github']))).toEqual([]);
  });

  it('reports the file errors that reject it whole', () => {
    expect(checkSettings({ sessions: { concurrency: 11, extra: 1 } }, new Set())).toEqual(['sessions.extra is not a setting.', 'sessions.concurrency must be a whole number from 1 to 10.']);
  });

  it("reports an enabled source's own keys, unknown sources and unknown template variables", () => {
    expect(
      checkSettings({
        sources: {
          github: { ...GITHUB, repo: 'nope', setupPrompt: '/init {{ticket.key}}' },
          forum: { setupPrompt: '{{x}}' },
          jira: {},
        },
      }, new Set(['github', 'forum', 'jira'])),
    ).toEqual([
      'sources.github.setupPrompt: Unknown template variable: ticket.key.',
      'sources.github.repo must be set to owner/name.',
      'sources.forum.setupPrompt: Unknown template variable: x.',
      'sources.forum.userId must be set to your forum user ID, as a string.',
      'sources.jira: Switchboard has no source named jira.',
    ]);
  });

  it("reports each playbook's errors and unknown template variables under its name", () => {
    expect(
      checkSettings({
        playbooks: {
          'dev:develop': TASK,
          'dev:x': { ...TASK, description: '', template: '{{nope}}' },
          'dev:y': { ...TASK, reports: 'done' },
          'triage:x': { description: 'Triage', kind: 'triage', template: 'Pick:\n{{playbooks}}\n' },
          'triage:y': { description: 'Triage', kind: 'triage', template: '{{ticket.sourceKey}}' },
          'dev:z': { ...TASK, template: '{{playbooks}}' },
          'Dev:x': TASK,
        },
      }, new Set()),
    ).toEqual([
      'playbooks.dev:x: description is required.',
      'playbooks.dev:x: Unknown template variable: nope.',
      'playbooks.dev:y: reports must be a list of strings.',
      'playbooks.triage:y: Unknown template variable: ticket.sourceKey.',
      'playbooks.dev:z: Unknown template variable: playbooks.',
      'playbooks.Dev:x: Namespace and name must be lowercase letters, digits and hyphens.',
    ]);
  });

  it('rejects a playbooks value that is not an object', () => {
    expect(checkSettings({ playbooks: [TASK] }, new Set())).toEqual(['playbooks must be an object.']);
  });
});

describe('sourceOptionsError', () => {
  it('uses each source’s own check', () => {
    expect(sourceOptionsError('github', GITHUB)).toBeNull();
    expect(sourceOptionsError('zoho', { orgId: '1' })).toBe('sources.zoho.agentId must be set to your Zoho agent ID, as a string.');
    expect(sourceOptionsError('forum', { userId: '7' })).toBeNull();
  });
});

describe('readConfigFile', () => {
  it('gives an empty object and no version without a settings file', () => {
    expect(readConfigFile(configDir())).toEqual({ path: settingsFile(), version: null, value: {}, error: null });
  });

  it('reports settings that are not JSON', () => {
    write(settingsFile(), '{ nope');

    const file = readConfigFile(configDir());

    expect(file).toMatchObject({ value: null, version: fileVersion('{ nope') });
    expect(file.error).toMatch(/^settings\.json is not valid JSON: /);
  });

  it('returns the playbooks inside the value, valid or not', () => {
    const text = JSON.stringify({ playbooks: { 'dev:develop': TASK, 'dev:bad': { description: 'x' } } });

    write(settingsFile(), text);

    expect(readConfigFile(configDir())).toEqual({ path: settingsFile(), version: fileVersion(text), value: JSON.parse(text), error: null });
  });
});

describe('loadConfig', () => {
  it('reads the playbooks from settings.json and leaves out invalid ones', () => {
    write(settingsFile(), JSON.stringify({ playbooks: { 'dev:develop': TASK, 'dev:bad': { description: 'x' } } }));

    const config = loadConfig(configDir());

    expect([...config.playbooks.keys()]).toEqual(['dev:develop']);
    expect(config.playbooks.get('dev:develop')).toMatchObject({ requiresWorktree: true, template: '/gc-plan {{ticket.sourceKey}}' });
    expect(config.playbookErrors).toEqual([{ name: 'dev:bad', error: 'The prompt template is empty.' }]);
    expect(config.settingsError).toBeNull();
  });

  it("leaves out a playbook that sessions.provider runs in Codex in a mode Codex cannot finish in, and reports it on a check", () => {
    const settings = { sessions: { provider: 'codex' }, playbooks: { 'dev:develop': TASK, 'dev:edits': { ...TASK, permissionMode: 'acceptEdits' }, 'dev:claude': { ...TASK, provider: 'claude', permissionMode: 'acceptEdits' } } };

    write(settingsFile(), JSON.stringify(settings));

    const config = loadConfig(configDir());
    const error = 'sessions.provider runs this playbook in Codex, whose permissionMode must be one of auto, plan, dontAsk, bypassPermissions.';

    expect([...config.playbooks.keys()]).toEqual(['dev:claude', 'dev:develop']);
    expect(config.playbookErrors).toEqual([{ name: 'dev:edits', error }]);
    expect(checkSettings(settings, new Set())).toEqual([`playbooks.dev:edits: ${error}`]);
    expect(checkSettings({ ...settings, sessions: { provider: 'claude' } }, new Set())).toEqual([]);
  });

  it('keeps the previous settings and playbooks when the file is invalid, and has none without a file', () => {
    write(settingsFile(), JSON.stringify({ sessions: { concurrency: 3 }, playbooks: { 'dev:develop': TASK } }));

    const valid = loadConfig(configDir());

    write(settingsFile(), JSON.stringify({ sessions: { concurrency: 0 }, playbooks: {} }));

    const invalid = loadConfig(configDir(), valid);

    expect(invalid.settings.sessions.concurrency).toBe(3);
    expect([...invalid.playbooks.keys()]).toEqual(['dev:develop']);
    expect(invalid.settingsError).toBe('sessions.concurrency must be a whole number from 1 to 10.');

    write(settingsFile(), '{ nope');
    expect([...loadConfig(configDir(), valid).playbooks.keys()]).toEqual(['dev:develop']);
  });
});

describe('saveSettings', () => {
  it('writes formatted JSON over the version it was read at, and creates a missing file', () => {
    expect(saveSettings(configDir(), { sessions: { concurrency: 1 } }, null, new Set(['github']))).toEqual({ errors: [], version: readConfigFile(configDir()).version });
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{\n  "sessions": {\n    "concurrency": 1\n  }\n}\n');

    const version = readConfigFile(configDir()).version;

    expect(saveSettings(configDir(), { sources: { github: GITHUB } }, version, new Set(['github']))).toEqual({ errors: [], version: readConfigFile(configDir()).version });
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toEqual({ sources: { github: GITHUB } });
  });

  it('refuses a file changed since it was read, and invalid settings, leaving the file alone', () => {
    write(settingsFile(), '{}');

    expect(saveSettings(configDir(), { triage: {} }, fileVersion('{"old": 1}'), new Set(['github']))).toEqual({ errors: ['settings.json changed on disk after the editor read it. Discard to load it.'], version: null });
    expect(saveSettings(configDir(), { triage: {} }, null, new Set(['github']))).toEqual({ errors: ['settings.json changed on disk after the editor read it. Discard to load it.'], version: null });
    expect(saveSettings(configDir(), { triage: { timeoutSeconds: 0 } }, fileVersion('{}'), new Set(['github']))).toEqual({ errors: ['triage.timeoutSeconds must be a whole number of at least 1.'], version: null });
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{}');
  });

  it('writes valid playbooks, and refuses an invalid one, leaving the file alone', () => {
    write(settingsFile(), '{}');

    expect(saveSettings(configDir(), { playbooks: { 'dev:develop': { ...TASK, template: '{{nope}}' } } }, fileVersion('{}'), new Set(['github']))).toEqual({
      errors: ['playbooks.dev:develop: Unknown template variable: nope.'],
      version: null,
    });
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{}');
    expect(saveSettings(configDir(), { playbooks: { 'dev:develop': TASK } }, fileVersion('{}'), new Set(['github']))).toEqual({ errors: [], version: readConfigFile(configDir()).version });
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toEqual({ playbooks: { 'dev:develop': TASK } });
  });
});
