import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlaybookFields } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPlaybook, checkSettings, deletePlaybook, fileVersion, readConfigFiles, savePlaybook, saveSettings, sourceOptionsError } from '../src/config.js';
import { tempHome } from './helpers.js';

let temp: ReturnType<typeof tempHome>;

beforeEach(() => {
  temp = tempHome();
});

afterEach(() => {
  temp.remove();
});

const settingsFile = () => join(temp.home, '.switchboard', 'settings.json');
const playbookFile = (namespace: string, name: string) => join(temp.home, '.switchboard', 'playbooks', namespace, `${name}.md`);

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

const GITHUB = { enabled: true, repo: 'o/r', logins: ['me'], project: { owner: 'o', number: 3 }, assignedStatuses: ['Dev'] };

const TASK: PlaybookFields = { description: 'Develop it', kind: 'task', autoStart: false, requiresWorktree: true, permissionMode: null, model: null, workdir: 'worktree', reports: [], template: '/gc-plan {{ticket.sourceKey}}\n' };

describe('checkSettings', () => {
  it('passes valid settings, and a disabled source whose own keys are incomplete', () => {
    expect(checkSettings({ sessions: { concurrency: 3 }, sources: { github: GITHUB, zoho: { enabled: false } } })).toEqual([]);
  });

  it('reports the file errors that reject it whole', () => {
    expect(checkSettings({ sessions: { concurrency: 9, extra: 1 } })).toEqual(['sessions.extra is not a setting.', 'sessions.concurrency must be a whole number from 1 to 4.']);
  });

  it("reports an enabled source's own keys, unknown sources and unknown template variables", () => {
    expect(
      checkSettings({
        sources: {
          github: { ...GITHUB, repo: 'nope', setupPrompt: '/init {{ticket.key}}' },
          forum: { enabled: true, pickPrompt: '{{x}}' },
          jira: { enabled: true },
        },
      }),
    ).toEqual([
      'sources.github.setupPrompt: Unknown template variable: ticket.key.',
      'sources.github.repo must be set to owner/name.',
      'sources.forum.pickPrompt: Unknown template variable: x.',
      'sources.forum.userId must be set to your forum user ID, as a string.',
      'sources.jira: Switchboard has no source named jira.',
    ]);
  });
});

describe('sourceOptionsError', () => {
  it('uses each source’s own check', () => {
    const { enabled: _enabled, ...options } = GITHUB;

    expect(sourceOptionsError('github', options)).toBeNull();
    expect(sourceOptionsError('zoho', { orgId: '1' })).toBe('sources.zoho.agentId must be set to your Zoho agent ID, as a string.');
    expect(sourceOptionsError('forum', { userId: '7' })).toBeNull();
  });
});

describe('readConfigFiles', () => {
  it('gives an empty object and no version without a settings file, and no playbooks without a directory', () => {
    expect(readConfigFiles(temp.home)).toEqual({ settings: { path: settingsFile(), version: null, value: {}, error: null }, playbooks: [] });
  });

  it('reports settings that are not JSON, and lists invalid playbooks with their errors', () => {
    write(settingsFile(), '{ nope');
    write(playbookFile('dev', 'develop'), '---\ndescription: Develop it\nrequiresWorktree: true\n---\n/gc-plan {{ticket.sourceKey}}\n');
    write(playbookFile('dev', 'bad'), 'no front matter');
    write(playbookFile('Dev2', 'x'), '---\ndescription: x\n---\nx\n');

    const files = readConfigFiles(temp.home);

    expect(files.settings).toMatchObject({ value: null, version: fileVersion('{ nope') });
    expect(files.settings.error).toMatch(/^settings\.json is not valid JSON: /);
    expect(files.playbooks.map(({ name, playbook, error }) => ({ name, playbook, error }))).toEqual([
      { name: 'Dev2:x', playbook: null, error: 'Namespace and name must be lowercase letters, digits and hyphens.' },
      { name: 'dev:bad', playbook: null, error: 'The file must start with front matter between --- lines.' },
      { name: 'dev:develop', playbook: TASK, error: null },
    ]);
    expect(files.playbooks[2]!.version).toBe(fileVersion(readFileSync(playbookFile('dev', 'develop'), 'utf8')));
  });
});

describe('saveSettings', () => {
  it('writes formatted JSON over the version it was read at, and creates a missing file', () => {
    expect(saveSettings(temp.home, { sessions: { concurrency: 1 } }, null)).toEqual([]);
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{\n  "sessions": {\n    "concurrency": 1\n  }\n}\n');

    const version = readConfigFiles(temp.home).settings.version;

    expect(saveSettings(temp.home, { sources: { github: GITHUB } }, version)).toEqual([]);
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toEqual({ sources: { github: GITHUB } });
  });

  it('refuses a file changed since it was read, and invalid settings, leaving the file alone', () => {
    write(settingsFile(), '{}');

    expect(saveSettings(temp.home, { triage: {} }, fileVersion('{"old": 1}'))).toEqual(['settings.json changed on disk after the editor read it. Reload to see the change.']);
    expect(saveSettings(temp.home, { triage: {} }, null)).toEqual(['settings.json changed on disk after the editor read it. Reload to see the change.']);
    expect(saveSettings(temp.home, { triage: { timeoutSeconds: 0 } }, fileVersion('{}'))).toEqual(['triage.timeoutSeconds must be a whole number of at least 1.']);
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{}');
  });
});

describe('savePlaybook and deletePlaybook', () => {
  it('creates a playbook, refuses to create it again, and updates it over its version', () => {
    expect(savePlaybook(temp.home, 'dev:develop', TASK, null)).toEqual([]);
    expect(readFileSync(playbookFile('dev', 'develop'), 'utf8')).toBe('---\ndescription: Develop it\nautoStart: false\nrequiresWorktree: true\n---\n/gc-plan {{ticket.sourceKey}}\n');
    expect(savePlaybook(temp.home, 'dev:develop', TASK, null)).toEqual(['A playbook named dev:develop already exists.']);

    const version = readConfigFiles(temp.home).playbooks[0]!.version;

    expect(savePlaybook(temp.home, 'dev:develop', { ...TASK, autoStart: true }, version)).toEqual([]);
    expect(readConfigFiles(temp.home).playbooks[0]!.playbook).toEqual({ ...TASK, autoStart: true });
    expect(savePlaybook(temp.home, 'dev:develop', TASK, version)).toEqual(['dev:develop changed on disk after the editor read it. Reload to see the change.']);
  });

  it('refuses a bad name, a playbook the hub would leave out, and unknown template variables, writing nothing', () => {
    expect(savePlaybook(temp.home, '../x:y', TASK, null)).toEqual(['The name must be namespace:name, in lowercase letters, digits and hyphens.']);
    expect(savePlaybook(temp.home, 'dev:x', { ...TASK, description: '' }, null)).toEqual(['description is required.']);
    expect(savePlaybook(temp.home, 'dev:x', { ...TASK, description: 'a\nb' }, null)).toEqual(['description must be one line.']);
    expect(savePlaybook(temp.home, 'dev:x', { ...TASK, template: '{{nope}}' }, null)).toEqual(['Unknown template variable: nope.']);
    expect(savePlaybook(temp.home, 'dev:x', { ...TASK, template: ' ' }, null)).toEqual(['The prompt template is empty.']);
    expect(existsSync(playbookFile('dev', 'x'))).toBe(false);
  });

  it('checks a playbook without writing it', () => {
    expect(checkPlaybook('dev:x', TASK)).toEqual({ text: '---\ndescription: Develop it\nautoStart: false\nrequiresWorktree: true\n---\n/gc-plan {{ticket.sourceKey}}\n' });
    expect(checkPlaybook('dev:x', { ...TASK, description: '', template: '{{nope}}' })).toEqual({ errors: ['description is required.', 'Unknown template variable: nope.'] });
    expect(checkPlaybook('triage:x', { ...TASK, kind: 'triage', template: 'Pick:\n{{playbooks}}\n' })).toEqual({ text: '---\ndescription: Develop it\nkind: triage\nrequiresWorktree: true\n---\nPick:\n{{playbooks}}\n' });
    expect(checkPlaybook('triage:x', { ...TASK, kind: 'triage', template: '{{ticket.sourceKey}}' })).toEqual({ errors: ['Unknown template variable: ticket.sourceKey.'] });
    expect(checkPlaybook('dev:x', { ...TASK, template: '{{playbooks}}' })).toEqual({ errors: ['Unknown template variable: playbooks.'] });
  });

  it('deletes a playbook only at the version it was read, and refuses one that is not listed', () => {
    write(playbookFile('dev', 'bad'), 'no front matter');

    expect(deletePlaybook(temp.home, 'dev:bad', fileVersion('other')!)).toEqual(['dev:bad changed on disk after the editor read it. Reload to see the change.']);
    expect(deletePlaybook(temp.home, 'dev:none', fileVersion('no front matter')!)).toEqual(['dev:none changed on disk after the editor read it. Reload to see the change.']);
    expect(existsSync(playbookFile('dev', 'bad'))).toBe(true);
    expect(deletePlaybook(temp.home, 'dev:bad', fileVersion('no front matter')!)).toEqual([]);
    expect(existsSync(playbookFile('dev', 'bad'))).toBe(false);
  });
});
