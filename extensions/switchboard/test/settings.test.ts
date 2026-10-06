import type { PlaybookFields } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fieldOfError, playbookFieldOfError, readField, renderEditor, samePlaybook, setAt } from '../src/webview/settings.js';
import type { EditorConfig, EditorState } from '../src/webview/settings.js';
import { startSettings } from '../src/webview/settingsMain.js';
import type { EditorMessage } from '../src/webview/settingsMain.js';

const TASK: PlaybookFields = { description: 'Develop it', kind: 'task', autoStart: false, requiresWorktree: true, permissionMode: null, model: null, workdir: 'worktree', reports: [], template: '/gc-plan {{ticket.sourceKey}}\n' };

const GITHUB = { enabled: true, repo: 'o/r', logins: ['me', 'me-ai'], project: { owner: 'o', number: 3 }, assignedStatuses: ['Dev'] };

function config(patch: Partial<EditorConfig> = {}): EditorConfig {
  return {
    settings: { path: 'H:/.switchboard/settings.json', version: 'v1', value: { sessions: { concurrency: 2 }, sources: { github: GITHUB, zoho: { enabled: false } } }, error: null },
    playbooks: [
      { name: 'dev:bad', path: 'H:/.switchboard/playbooks/dev/bad.md', version: 'p3', playbook: null, error: 'description is required.' },
      { name: 'dev:develop', path: 'H:/.switchboard/playbooks/dev/develop.md', version: 'p1', playbook: TASK, error: null },
      { name: 'triage:github', path: 'H:/.switchboard/playbooks/triage/github.md', version: 'p2', playbook: { ...TASK, kind: 'triage', description: 'GitHub triage', requiresWorktree: false, template: 'Classify.\n' }, error: null },
    ],
    permissionModes: ['acceptEdits', 'auto', 'plan'],
    templateVariables: ['ticket.sourceKey', 'session.id'],
    sourceKinds: ['github', 'zoho', 'forum'],
    ...patch,
  };
}

describe('readField and setAt', () => {
  it('reads each kind of input, with an empty input removing the key', () => {
    expect(readField('text', { value: '' })).toBeUndefined();
    expect(readField('text', { value: ' x ' })).toBe(' x ');
    expect(readField('integer', { value: ' 12 ' })).toBe(12);
    expect(readField('integer', { value: '1.5' })).toBe('1.5');
    expect(readField('integer', { value: '  ' })).toBeUndefined();
    expect(readField('boolean', { value: 'on', checked: false })).toBe(false);
    expect(readField('list', { value: ' a \r\n\n b ' })).toEqual(['a', 'b']);
    expect(readField('list', { value: '\n' })).toBeUndefined();
    expect(readField('select', { value: '' })).toBeUndefined();
  });

  it('sets and removes nested keys without changing the original', () => {
    const root = { sources: { github: { repo: 'o/r' } } };

    expect(setAt(root, 'sources.github.project.number', 3)).toEqual({ sources: { github: { repo: 'o/r', project: { number: 3 } } } });
    expect(setAt(root, 'sources.github.repo', undefined)).toEqual({ sources: { github: {} } });
    expect(root).toEqual({ sources: { github: { repo: 'o/r' } } });
  });
});

describe('fieldOfError', () => {
  const paths = ['sessions.concurrency', 'sources.github.enabled', 'sources.github.repo', 'sources.github.project.owner', 'sources.github.project.number', 'sources.github.setupPrompt'];

  it.each([
    ['sessions.concurrency must be a whole number from 1 to 4.', 'sessions.concurrency'],
    ['sources.github.repo must be set to owner/name.', 'sources.github.repo'],
    ['sources.github.project must give owner and number.', 'sources.github.project.owner'],
    ['sources.github.setupPrompt: Unknown template variable: x.', 'sources.github.setupPrompt'],
    ['sources.github: Switchboard has no source named github.', 'sources.github.enabled'],
    ['sources.github.extra is not a setting.', null],
    ['sessions must be an object.', null],
  ])('maps %s', (error, field) => {
    expect(fieldOfError(error, paths)).toBe(field);
  });

  it('maps playbook errors by their leading key, or to the template', () => {
    const fields = ['description', 'kind', 'model', 'template'];

    expect(playbookFieldOfError('description is required.', fields)).toBe('description');
    expect(playbookFieldOfError('model must be one line.', fields)).toBe('model');
    expect(playbookFieldOfError('Unknown template variable: x.', fields)).toBe('template');
    expect(playbookFieldOfError('Unknown front matter: x.', fields)).toBeNull();
  });
});

describe('samePlaybook', () => {
  it('ignores the final newline and CRLF that saving normalizes', () => {
    expect(samePlaybook({ ...TASK, template: 'a\r\nb' }, { ...TASK, template: 'a\nb\n' })).toBe(true);
    expect(samePlaybook({ ...TASK, template: 'a' }, { ...TASK, template: 'b\n' })).toBe(false);
    expect(samePlaybook(TASK, null)).toBe(false);
  });
});

describe('renderEditor', () => {
  it('lists the settings, configured and missing sources, and playbooks by namespace', () => {
    const root = document.createElement('div');
    const state: EditorState = {
      config: config(),
      page: 'general',
      settingsDraft: null,
      playbookDrafts: new Map(),
      newPlaybook: { namespace: '', name: '', playbook: TASK, touched: false },
      settingsErrors: [],
      playbookErrors: new Map(),
      refusals: new Map(),
    };

    root.innerHTML = renderEditor(state);

    expect([...root.querySelectorAll('nav .nav-item')].map((item) => item.textContent)).toEqual(['Sessions and triage', 'GitHub', 'Zoho Deskoff', 'Add Forum', 'bad', 'develop', 'github', 'New playbook']);
    expect([...root.querySelectorAll('.nav-namespace')].map((item) => item.textContent)).toEqual(['dev', 'triage']);
    expect(root.querySelector('[data-arg="playbook:dev:bad"] .codicon-error')).not.toBeNull();
    expect(root.querySelector('[data-arg="playbook:dev:develop"] .codicon-error')).toBeNull();
  });
});

describe('startSettings', () => {
  let root: HTMLElement;
  let posted: Record<string, unknown>[];

  const send = (message: EditorMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  const field = <T extends HTMLElement>(path: string) => root.querySelector<T>(`[data-field="${path}"]`)!;
  const click = (selector: string) => root.querySelector<HTMLElement>(selector)!.click();
  const type = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, event = 'input') => {
    element.value = value;
    element.dispatchEvent(new Event(event, { bubbles: true }));
  };
  const last = (type: string) => posted.filter((message) => message['type'] === type).at(-1);

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.replaceChildren(root);
    // Earlier tests' editors still listen on the window, so each editor posts to its own list.
    const sink: Record<string, unknown>[] = [];

    posted = sink;
    startSettings(root, { postMessage: (message) => sink.push(message as Record<string, unknown>) }, 50);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for the files, then checks the settings it shows', () => {
    expect(posted).toEqual([{ type: 'ready' }]);

    send({ type: 'config', config: config() });

    expect(posted.at(-1)).toEqual({ type: 'check', target: 'settings', seq: 1, settings: config().settings.value });
    expect(field<HTMLInputElement>('sessions.concurrency').value).toBe('2');
    expect(field<HTMLSelectElement>('sessions.permissionMode').value).toBe('auto');
    expect(field<HTMLInputElement>('sessions.installHooks').checked).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-command="save"]')!.disabled).toBe(true);
  });

  it('keeps an edit as a draft, checks it after a pause, and saves it over the version it started from', () => {
    send({ type: 'config', config: config() });
    type(field('sessions.concurrency'), '3');

    expect(root.querySelector<HTMLButtonElement>('[data-command="save"]')!.disabled).toBe(false);
    expect(root.querySelector('[data-arg="general"] .dot')).not.toBeNull();
    expect(last('check')!['seq']).toBe(1);

    vi.advanceTimersByTime(50);

    expect(last('check')).toMatchObject({ seq: 2, settings: { sessions: { concurrency: 3 } } });

    click('[data-command="save"]');

    expect(last('save-settings')).toEqual({ type: 'save-settings', value: { sessions: { concurrency: 3 }, sources: { github: GITHUB, zoho: { enabled: false } } }, version: 'v1' });

    send({ type: 'saved', target: 'settings' });
    send({ type: 'config', config: config({ settings: { ...config().settings, version: 'v2', value: { sessions: { concurrency: 3 }, sources: { github: GITHUB, zoho: { enabled: false } } } } }) });

    expect(root.querySelector<HTMLButtonElement>('[data-command="save"]')!.disabled).toBe(true);
    expect(root.querySelector('nav .dot')).toBeNull();
  });

  it('shows check errors on their fields and pages, ignoring a stale check', () => {
    send({ type: 'config', config: config() });
    send({ type: 'checked', target: 'settings', seq: 1, errors: ['sources.github.repo must be set to owner/name.', 'settings.extra is not a setting.'] });

    expect(root.querySelector('.page-errors')!.textContent).toBe('settings.extra is not a setting.');
    expect(root.querySelector('[data-arg="source:github"] .codicon-error')).not.toBeNull();

    click('[data-arg="source:github"]');

    expect(root.querySelector('[data-errors-for="sources.github.repo"]')!.textContent).toBe('sources.github.repo must be set to owner/name.');
    expect(field('sources.github.repo').closest('.field')!.classList.contains('invalid')).toBe(true);

    // Navigating checked again (seq 2), so the answer to seq 1 is stale.
    send({ type: 'checked', target: 'settings', seq: 1, errors: [] });
    expect(root.querySelector('[data-errors-for="sources.github.repo"]')!.textContent).not.toBe('');

    send({ type: 'checked', target: 'settings', seq: 2, errors: [] });
    expect(root.querySelector('[data-errors-for="sources.github.repo"]')!.textContent).toBe('');
    expect(field('sources.github.repo').closest('.field')!.classList.contains('invalid')).toBe(false);
  });

  it("edits a source's lists and nested keys, and shows only a pool source's pick prompt", () => {
    send({ type: 'config', config: config() });
    click('[data-arg="source:github"]');

    expect(field<HTMLTextAreaElement>('sources.github.logins').value).toBe('me\nme-ai');
    expect(field('sources.github.pickPrompt')).toBeNull();
    expect([...field<HTMLSelectElement>('sources.github.triagePlaybook').options].map((option) => option.value)).toEqual(['', 'triage:github']);

    type(field('sources.github.logins'), 'me\n\nother ');
    type(field('sources.github.project.number'), '');
    vi.advanceTimersByTime(50);

    expect(last('check')!['settings']).toMatchObject({ sources: { github: { logins: ['me', 'other'], project: { owner: 'o' } } } });
    expect((last('check')!['settings'] as { sources: { github: { project: object } } }).sources.github.project).toEqual({ owner: 'o' });

    click('[data-arg="source:zoho"]');
    expect(field('sources.zoho.pickPrompt')).not.toBeNull();
    expect(field<HTMLInputElement>('sources.zoho.enabled').checked).toBe(false);
  });

  it('adds a missing source as a disabled draft, and removes a source', () => {
    send({ type: 'config', config: config() });
    click('[data-command="add-source"][data-arg="forum"]');

    expect(root.querySelector('header h2')!.textContent).toBe('Forum sources.forum');
    expect(field('sources.forum.userId')).not.toBeNull();
    expect(last('check')!['settings']).toMatchObject({ sources: { forum: { enabled: false } } });
    expect(root.querySelector('[data-command="add-source"]')).toBeNull();

    click('[data-command="remove-source"]');

    expect(root.querySelector('header h2')!.textContent).toBe('Sessions and triage');
    expect(Object.keys((last('check')!['settings'] as { sources: object }).sources)).toEqual(['github', 'zoho']);
  });

  it('reverts a draft', () => {
    send({ type: 'config', config: config() });
    type(field('sessions.model'), 'opus');
    click('[data-command="revert"]');

    expect(field<HTMLInputElement>('sessions.model').value).toBe('');
    expect(root.querySelector<HTMLButtonElement>('[data-command="save"]')!.disabled).toBe(true);
  });

  it('warns when the file changed under a draft, and keeps a refusal across checks and refreshes until the next edit', () => {
    send({ type: 'config', config: config() });
    type(field('sessions.model'), 'opus');
    send({ type: 'config', config: config({ settings: { ...config().settings, version: 'v9' } }) });

    expect(root.querySelector('.changed')!.textContent).toBe('settings.json changed on disk. Revert to load it, or Save to see the refusal.');
    expect(field<HTMLInputElement>('sessions.model').value).toBe('opus');

    send({ type: 'refused', target: 'settings', errors: ['settings.json changed on disk after the editor read it. Reload to see the change.'] });
    send({ type: 'checked', target: 'settings', seq: 2, errors: [] });
    send({ type: 'config', config: config({ settings: { ...config().settings, version: 'v9' } }) });
    send({ type: 'checked', target: 'settings', seq: 3, errors: [] });

    expect(root.querySelector('.page-errors')!.textContent).toBe('settings.json changed on disk after the editor read it. Reload to see the change.');

    type(field('sessions.model'), 'opus2');
    expect(root.querySelector('.page-errors')!.textContent).toBe('');
  });

  it('shows a settings file that is not JSON, with no fields', () => {
    send({ type: 'config', config: config({ settings: { path: 'H:/s.json', version: 'x', value: null, error: 'settings.json is not valid JSON: Unexpected token' } }) });

    expect(root.querySelector('.page-errors')!.textContent).toBe('settings.json is not valid JSON: Unexpected token');
    expect(root.querySelector('[data-field]')).toBeNull();
    expect(posted.filter((message) => message['type'] === 'check')).toEqual([]);
  });

  it('edits a playbook, hides the task fields on a triage playbook, and saves over its version', () => {
    send({ type: 'config', config: config() });
    click('[data-arg="playbook:dev:develop"]');

    expect(last('check')).toEqual({ type: 'check', target: 'dev:develop', seq: 2, name: 'dev:develop', playbook: TASK });
    expect(field<HTMLSelectElement>('permissionMode').selectedOptions[0]!.textContent).toBe('Sessions setting (auto)');
    expect(field<HTMLInputElement>('model').placeholder).toBe('Sessions setting (Claude’s default)');

    type(field('description'), 'Plan and build it');
    type(field('permissionMode'), 'plan', 'change');
    field<HTMLInputElement>('autoStart').checked = true;
    field('autoStart').dispatchEvent(new Event('change', { bubbles: true }));
    expect([field<HTMLInputElement>('reports.done').checked, field<HTMLInputElement>('reports.approval').checked]).toEqual([false, false]);

    for (const kind of ['worktree', 'done', 'playbook']) {
      field<HTMLInputElement>(`reports.${kind}`).checked = true;
      field(`reports.${kind}`).dispatchEvent(new Event('change', { bubbles: true }));
    }

    expect(field<HTMLInputElement>('reports.done').checked).toBe(true);
    type(field('kind'), 'triage', 'change');

    expect(field('autoStart')).toBeNull();
    expect(field('reports.done')).toBeNull();
    expect(field('reports.playbook')).toBeNull();
    expect(root.querySelector('label[for]')).not.toBeNull();

    type(field('kind'), 'task', 'change');
    click('[data-command="save"]');

    expect(last('save-playbook')).toEqual({
      type: 'save-playbook',
      name: 'dev:develop',
      playbook: { ...TASK, description: 'Plan and build it', permissionMode: 'plan', autoStart: true, reports: ['done', 'worktree', 'playbook'] },
      version: 'p1',
    });

    send({ type: 'checked', target: 'dev:develop', seq: 2, errors: ['description must be one line.', 'Unknown front matter: x.'] });

    expect(root.querySelector('[data-errors-for="description"]')!.textContent).toBe('description must be one line.');
    expect(root.querySelector('.page-errors')!.textContent).toBe('Unknown front matter: x.');
  });

  it('drops a playbook draft once the file matches it', () => {
    send({ type: 'config', config: config() });
    click('[data-arg="playbook:dev:develop"]');
    type(field('template'), '/gc-plan {{ticket.sourceKey}}');

    expect(root.querySelector('[data-arg="playbook:dev:develop"] .dot')).toBeNull();

    type(field('template'), '/gc-plan');
    expect(root.querySelector('[data-arg="playbook:dev:develop"] .dot')).not.toBeNull();

    send({ type: 'config', config: config({ playbooks: config().playbooks.map((entry) => (entry.name === 'dev:develop' ? { ...entry, version: 'p5', playbook: { ...TASK, template: '/gc-plan\n' } } : entry)) }) });
    expect(root.querySelector('[data-arg="playbook:dev:develop"] .dot')).toBeNull();
    expect(root.querySelector('.changed')).toBeNull();
  });

  it('keeps a draft whose file is deleted on disk, and saves it as a new file', () => {
    send({ type: 'config', config: config() });
    click('[data-arg="playbook:dev:develop"]');
    type(field('template'), '/gc-plan --fast');
    send({ type: 'config', config: config({ playbooks: config().playbooks.filter((entry) => entry.name !== 'dev:develop') }) });

    expect(root.querySelector('.changed')!.textContent).toBe('dev:develop was deleted on disk. Save creates it again; Revert discards your changes.');
    expect(field<HTMLTextAreaElement>('template').value).toBe('/gc-plan --fast');
    expect(root.querySelector('[data-arg="playbook:dev:develop"] .dot')).not.toBeNull();
    expect(root.querySelector('[data-command="delete"]')).toBeNull();

    click('[data-command="save"]');
    expect(last('save-playbook')).toEqual({ type: 'save-playbook', name: 'dev:develop', playbook: { ...TASK, template: '/gc-plan --fast' }, version: null });
  });

  it('keeps a draft whose file breaks on disk, showing the file error', () => {
    send({ type: 'config', config: config() });
    click('[data-arg="playbook:dev:develop"]');
    type(field('template'), '/gc-plan --fast');
    send({ type: 'config', config: config({ playbooks: config().playbooks.map((entry) => (entry.name === 'dev:develop' ? { ...entry, version: 'p7', playbook: null, error: 'kind must be task or triage.' } : entry)) }) });

    expect(root.querySelector('.page-errors')!.textContent).toBe('On disk: kind must be task or triage.');
    expect(field<HTMLTextAreaElement>('template').value).toBe('/gc-plan --fast');

    click('[data-command="save"]');
    expect(last('save-playbook')).toMatchObject({ version: 'p1' });
  });

  it("keeps a missing settings file's null version when the file appears under the draft", () => {
    send({ type: 'config', config: config({ settings: { path: 'H:/s.json', version: null, value: {}, error: null } }) });
    type(field('sessions.model'), 'opus');
    send({ type: 'config', config: config({ settings: { path: 'H:/s.json', version: 'v5', value: { sessions: { concurrency: 4 } }, error: null } }) });
    type(field('triage.model'), 'haiku');
    click('[data-command="save"]');

    expect(last('save-settings')).toEqual({ type: 'save-settings', value: { sessions: { model: 'opus' }, triage: { model: 'haiku' } }, version: null });
  });

  it('shows the default automation agents, and saves an emptied list as empty', () => {
    send({ type: 'config', config: config() });
    click('[data-arg="source:zoho"]');

    expect(field<HTMLTextAreaElement>('sources.zoho.automationAgentIds').value).toBe('8000000000000000002\n8000000000000000003');

    type(field('sources.zoho.automationAgentIds'), '');
    click('[data-command="save"]');

    expect(last('save-settings')!['value']).toMatchObject({ sources: { zoho: { enabled: false, automationAgentIds: [] } } });
  });

  it('saves settings and every changed playbook with Save all, and marks the pages it refused', () => {
    send({ type: 'config', config: config() });

    expect(root.querySelector<HTMLButtonElement>('[data-command="save-all"]')!.disabled).toBe(true);

    type(field('sessions.model'), 'opus');
    click('[data-arg="playbook:dev:develop"]');
    type(field('template'), '/gc-plan --fast');
    click('[data-arg="playbook:triage:github"]');
    // A draft that matches its file is not saved.
    type(field('template'), 'Classify.');

    expect(root.querySelector<HTMLButtonElement>('[data-command="save"]')!.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-command="save-all"]')!.disabled).toBe(false);

    click('[data-arg="new-playbook"]');
    expect(root.querySelector<HTMLButtonElement>('[data-command="save-all"]')!.disabled).toBe(false);

    const before = posted.length;

    click('[data-command="save-all"]');

    expect(posted.slice(before)).toEqual([
      { type: 'save-settings', value: { sessions: { concurrency: 2, model: 'opus' }, sources: { github: GITHUB, zoho: { enabled: false } } }, version: 'v1' },
      { type: 'save-playbook', name: 'dev:develop', playbook: { ...TASK, template: '/gc-plan --fast' }, version: 'p1' },
    ]);

    send({ type: 'refused', target: 'dev:develop', errors: ['dev:develop changed on disk after the editor read it.'] });
    send({ type: 'refused', target: 'settings', errors: ['EACCES: permission denied'] });

    expect(root.querySelector('[data-arg="playbook:dev:develop"] .codicon-error')).not.toBeNull();
    expect(root.querySelector('[data-arg="general"] .codicon-error')).not.toBeNull();
    expect(root.querySelector('[data-arg="playbook:triage:github"] .codicon-error')).toBeNull();
  });

  it('keeps a save refusal when a check was still pending', () => {
    send({ type: 'config', config: config() });
    type(field('sessions.model'), 'opus');
    click('[data-command="save"]');
    send({ type: 'refused', target: 'settings', errors: ['EACCES: permission denied'] });
    vi.advanceTimersByTime(100);

    expect(posted.filter((message) => message['type'] === 'check').length).toBe(1);
    expect(root.querySelector('.page-errors')!.textContent).toBe('EACCES: permission denied');
  });

  it('deletes an invalid playbook, and opens its file', () => {
    send({ type: 'config', config: config() });
    click('[data-arg="playbook:dev:bad"]');

    expect(root.querySelector('.page-errors')!.textContent).toBe('description is required.');

    click('[data-command="delete"]');
    expect(last('delete-playbook')).toEqual({ type: 'delete-playbook', name: 'dev:bad', version: 'p3' });

    send({ type: 'refused', target: 'dev:bad', errors: ['EPERM: operation not permitted'] });
    send({ type: 'config', config: config() });
    expect(root.querySelector('.page-errors')!.textContent).toBe('description is required.EPERM: operation not permitted');

    click('[data-command="open-file"]');
    expect(last('open-file')).toEqual({ type: 'open-file', path: 'H:/.switchboard/playbooks/dev/bad.md' });

    send({ type: 'deleted', name: 'dev:bad' });
    expect(root.querySelector('header h2')!.textContent).toBe('Sessions and triage');
  });

  it('creates a playbook once its name is valid, then shows it', () => {
    send({ type: 'config', config: config() });
    click('[data-arg="new-playbook"]');
    click('[data-command="create"]');

    expect(root.querySelector('[data-errors-for="name"]')!.textContent).toBe('Namespace and name must be lowercase letters, digits and hyphens.');
    expect(last('create-playbook')).toBeUndefined();

    type(root.querySelector('[data-new="namespace"]')!, 'dev');
    type(root.querySelector('[data-new="name"]')!, 'develop');
    expect(root.querySelector('[data-errors-for="name"]')!.textContent).toBe('A playbook named dev:develop already exists.');

    type(root.querySelector('[data-new="name"]')!, 'fix');
    type(field('description'), 'Fix it');
    type(field('template'), '/fix');
    vi.advanceTimersByTime(50);

    expect(last('check')).toMatchObject({ target: 'new', name: 'dev:fix', playbook: { description: 'Fix it', template: '/fix' } });

    click('[data-command="create"]');
    expect(last('create-playbook')).toEqual({ type: 'create-playbook', name: 'dev:fix', playbook: { ...TASK, requiresWorktree: false, description: 'Fix it', template: '/fix' } });

    send({ type: 'config', config: config({ playbooks: [...config().playbooks, { name: 'dev:fix', path: 'H:/fix.md', version: 'p9', playbook: { ...TASK, requiresWorktree: false, description: 'Fix it', template: '/fix\n' }, error: null }] }) });
    send({ type: 'saved', target: 'new' });

    expect(root.querySelector('header h2')!.textContent).toBe('dev:fix');
    expect(root.querySelector<HTMLButtonElement>('[data-command="save"]')!.disabled).toBe(true);
  });
});
