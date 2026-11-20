import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSettings, fileVersion, loadConfig, readConfigFile, saveSettings, sourceOptionsError } from '../src/config.js';
import { pluginSet } from '../src/plugins.js';
import type { SourcePlugin } from '@switchboard/core';
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

/** A plugin module's export, which checks one key. */
const FORUM: SourcePlugin = {
  kind: 'forum',
  label: 'Forum',
  queue: true,
  optionsError: (options, name) => (typeof options['userId'] === 'string' ? null : `sources.${name}.userId must be set.`),
  create: () => ({ error: 'not built in this test' }),
};

const FORUM_PLUGINS = pluginSet([['D:/plugins/forum.js', { plugin: FORUM }]]);

const GITHUB = { repo: 'o/r', logins: ['me'], project: { owner: 'o', number: 3 }, assignedStatuses: ['Dev'] };

const TASK = { description: 'Develop it', requiresWorktree: true, template: '/sb-plan {{ticket.sourceKey}}' };

describe('checkSettings', () => {
  it('passes valid settings, and a disabled source whose own keys are incomplete', () => {
    expect(checkSettings({ sessions: { concurrency: 3 }, sources: { github: GITHUB, zoho: {} } }, new Set(['github']))).toEqual([]);
  });

  it('checks a second source of one kind by its kind and names it in errors (PRD R3)', () => {
    expect(checkSettings({ sources: { github: GITHUB, 'widgets-dashboard': { kind: 'github', repo: 'nope' } } }, new Set(['github', 'widgets-dashboard']))).toEqual([
      'sources.widgets-dashboard.repo must be set to owner/name.',
    ]);
  });

  it('refuses a source named after another kind, including a plugin kind, and two GitHub sources on one board, even when off (PRD R3)', () => {
    expect(
      checkSettings(
        {
          sources: {
            github: GITHUB,
            zoho: { kind: 'github' },
            forum: { kind: 'github' },
            'desk-again': { kind: 'zoho' },
            personal: { kind: 'github', project: { owner: 'O', number: 3 } },
            other: { kind: 'github', project: { owner: 'o', number: 4 } },
          },
        },
        new Set(),
        {},
        FORUM_PLUGINS,
      ),
    ).toEqual([
      'sources.zoho: zoho is a source kind, so a source of kind github needs another name.',
      'sources.forum: forum is a source kind, so a source of kind github needs another name.',
      'sources.personal.project: sources.github already reads project o/3.',
    ]);
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
      }, new Set(['github', 'forum', 'jira']), {}, FORUM_PLUGINS),
    ).toEqual([
      'sources.github.setupPrompt: Unknown template variable: ticket.key.',
      'sources.github.repo must be set to owner/name.',
      'sources.forum.setupPrompt: Unknown template variable: x.',
      'sources.forum.userId must be set.',
      'sources.jira: Switchboard has no source kind jira.',
    ]);
  });

  it('reports each plugin that failed to load, and with it the kind it would have given', () => {
    const plugins = pluginSet([['D:/plugins/broken.js', { error: 'it could not be loaded: Cannot find module.' }], ['D:/plugins/forum2.js', { plugin: FORUM }]]);

    expect(checkSettings({ sources: { jira: {} } }, new Set(['jira']), {}, plugins)).toEqual([
      'plugins: D:/plugins/broken.js: it could not be loaded: Cannot find module.',
      'sources.jira: Switchboard has no source kind jira. plugins: D:/plugins/broken.js: it could not be loaded: Cannot find module.',
    ]);
  });

  it('reports a schedule whose playbook is missing, is a triage playbook, or needs a worktree (PRD R82)', () => {
    const schedule = (playbook: string) => ({ playbook, repoRoot: 'D:/git/widgets', every: 'week', day: 'mon', at: '09:00' });

    expect(
      checkSettings({
        schedules: { ok: schedule('ops:cleanup'), gone: schedule('ops:gone'), triage: schedule('triage:github'), worktree: schedule('dev:develop') },
        playbooks: { 'ops:cleanup': { description: 'Clean up', template: '/cleanup-worktrees' }, 'triage:github': { description: 'Triage', kind: 'triage', template: 'Classify.' }, 'dev:develop': TASK },
      }, new Set()),
    ).toEqual([
      'schedules.gone.playbook names no task playbook: ops:gone.',
      'schedules.triage.playbook names no task playbook: triage:github.',
      'schedules.worktree.playbook names dev:develop, which needs a worktree that a schedule cannot set up.',
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
    expect(sourceOptionsError('github', 'github', GITHUB)).toBeNull();
    expect(sourceOptionsError('zoho', 'zoho', { orgId: '1' })).toBe('sources.zoho.agentId must be set to your Zoho agent ID, as a string.');
    expect(sourceOptionsError('forum', 'forum', { userId: '7' }, FORUM_PLUGINS)).toBeNull();
    expect(sourceOptionsError('forum', 'forum', { userId: '7' })).toBe('sources.forum: Switchboard has no source kind forum.');
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

  it("gives voice.expandReplies as its inverse voice.briefReplies, which the editors save in its place, and leaves the file's text and version as they are", () => {
    const value = (voice: unknown) => {
      const text = JSON.stringify({ sessions: { installHooks: false }, voice });

      write(settingsFile(), text);
      const file = readConfigFile(configDir());

      expect(file.version).toBe(fileVersion(text));
      expect(readFileSync(settingsFile(), 'utf8')).toBe(text);
      return (file.value as { voice: unknown }).voice;
    };

    expect(value({ voice: 'cedar', expandReplies: false })).toEqual({ voice: 'cedar', briefReplies: true });
    expect(value({ expandReplies: true })).toEqual({ briefReplies: false });
    // A file that has both keeps briefReplies; one with neither, or an invalid old value, is left for the editors to show.
    expect(value({ expandReplies: true, briefReplies: true })).toEqual({ briefReplies: true });
    expect(value({ voice: 'cedar' })).toEqual({ voice: 'cedar' });
    expect(value({ expandReplies: 'yes' })).toEqual({ expandReplies: 'yes' });
    expect(value({ expandReplies: true, briefReplies: 'yes' })).toEqual({ briefReplies: 'yes' });
    expect(value([])).toEqual([]);
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
    expect(config.playbooks.get('dev:develop')).toMatchObject({ requiresWorktree: true, template: '/sb-plan {{ticket.sourceKey}}' });
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

describe('labels and home repositories between sources (PRD R27, R44)', () => {
  it('refuses a label that names a source or repeats for another repository', () => {
    expect(
      checkSettings({ sources: { github: { ...GITHUB, labels: { 'o/dash': 'dash', 'o/x': 'personal', 'o/y': 'gh' } }, personal: { kind: 'github', labels: { 'o/other': 'dash', 'O/Dash': 'dash' } } } }, new Set()),
    ).toEqual(['sources.github.labels.o/x: personal names a source.', 'sources.github.labels.o/y: gh names a source.', 'sources.personal.labels.o/other: dash already labels o/dash.']);
  });

  it("refuses a home repository other than the one the source's tickets record, at check, save and load, and allows one for a source without tickets", () => {
    const moved = { sources: { github: { ...GITHUB, repo: 'O/Elsewhere' } } };
    const error = 'sources.github.repo cannot change from o/r while the source has tickets; add another source for o/elsewhere.';

    expect(checkSettings(moved, new Set(), { github: 'o/r' })).toEqual([error]);
    expect(checkSettings({ sources: { github: { ...GITHUB, repo: 'O/R' } } }, new Set(), { github: 'o/r' })).toEqual([]);
    expect(checkSettings(moved, new Set(), { personal: 'o/r' })).toEqual([]);

    write(settingsFile(), JSON.stringify({ sources: { github: GITHUB } }));
    const valid = loadConfig(configDir(), undefined, { github: 'o/r' });
    write(settingsFile(), JSON.stringify(moved));
    expect(loadConfig(configDir(), valid, { github: 'o/r' })).toMatchObject({ settingsError: error, settings: valid.settings });
    expect(saveSettings(configDir(), moved, fileVersion(readFileSync(settingsFile(), 'utf8')), new Set(), { github: 'o/r' })).toEqual({ errors: [error], version: null });
  });
});

describe('loadConfig between sources', () => {
  it('keeps the last valid settings when two GitHub sources read one board (PRD R42)', () => {
    write(settingsFile(), JSON.stringify({ sources: { github: GITHUB } }));
    const valid = loadConfig(configDir());
    write(settingsFile(), JSON.stringify({ sources: { github: GITHUB, personal: { kind: 'github', project: GITHUB.project } } }));
    const invalid = loadConfig(configDir(), valid);

    expect(invalid.settingsError).toBe('sources.personal.project: sources.github already reads project o/3.');
    expect(Object.keys(invalid.settings.sources)).toEqual(['github']);
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

    expect(saveSettings(configDir(), { triage: {} }, fileVersion('{"old": 1}'), new Set(['github']))).toEqual({ errors: ['settings.json changed on disk after the editor read it. Discard your changes and open Settings again to load it.'], version: null });
    expect(saveSettings(configDir(), { triage: {} }, null, new Set(['github']))).toEqual({ errors: ['settings.json changed on disk after the editor read it. Discard your changes and open Settings again to load it.'], version: null });
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
