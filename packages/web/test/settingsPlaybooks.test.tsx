import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_DELAY_MS, settings } from '../src/settings.js';
import { getAt } from '../src/settingsModel.js';

type Answer = { status: number; body: Record<string, unknown> };

const config = (value: unknown, patch: Record<string, unknown> = {}) => ({
  settings: { path: 'C:/home/.switchboard/settings.json', version: 'v1', value, error: null },
  permissionModes: ['default', 'auto', 'plan', 'bypassPermissions'],
  codexPermissionModes: ['default', 'bypassPermissions'],
  providers: ['claude', 'codex'],
  templateVariables: ['ticket.title'],
  sourceKinds: ['github', 'zoho', 'forum'],
  inUse: {},
  enabled: {},
  configDir: 'C:/home/.switchboard',
  ...patch,
});

describe('Settings playbooks (architecture.md § Web page)', () => {
  let host: HTMLElement;
  let posts: Array<{ name: string; body: Record<string, unknown> }>;
  let answers: Record<string, Answer | ((body: Record<string, unknown>) => Answer)>;
  const file = {
    sessions: { installHooks: false, provider: 'claude', codex: { permissionMode: 'default' } },
    playbooks: {
      'dev:build': { description: 'Build it', autoStart: true, requiresWorktree: false, reports: ['done', 'approval'], approvalSends: true, template: 'Build {{ticket.title}}.' },
      'dev:triage': { description: 'Sort', kind: 'triage', rates: true, template: 'Classify.' },
      'ops:broken': { description: 'B', color: 'red' },
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    posts = [];
    answers = { 'page-settings-read': { status: 200, body: config(file, { inUse: { 'dev:build': 2 } }) }, 'page-settings-check': { status: 200, body: { errors: [] } } };
    host = document.createElement('div');
    document.body.replaceChildren(host);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const open = async () => {
    const pane = settings(host, {
      post: async (name, body) => {
        posts.push({ name, body });
        const answer = answers[name];
        return typeof answer === 'function' ? answer(body) : (answer ?? { status: 404, body: {} });
      },
    });

    pane.open();
    await vi.advanceTimersByTimeAsync(0);
    return pane;
  };
  const texts = (selector: string) => [...host.querySelectorAll(selector)].map((node) => node.textContent);
  const entry = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.settings-nav-entry')].find((one) => one.querySelector('.settings-nav-label')?.textContent === label)!;
  const control = <T extends HTMLElement>(path: string) => host.querySelector<T>(`[data-path="${path}"] input, [data-path="${path}"] select, [data-path="${path}"] textarea`)!;
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const checked = () => posts.filter((one) => one.name === 'page-settings-check').at(-1)!.body['settings'] as { playbooks: Record<string, unknown> };
  const pick = (path: string, value: string) => {
    const box = control<HTMLSelectElement>(path);

    box.value = value;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('lists each namespace with its playbooks under Playbooks, then New playbook, marking an entry it cannot read', async () => {
    await open();

    const labels = texts('.settings-nav-entry .settings-nav-label');

    expect(labels.slice(labels.indexOf('dev'), labels.indexOf('+ New playbook') + 1)).toEqual(['dev', 'build', 'triage', 'ops', 'broken', '+ New playbook']);
    expect(texts('.settings-nav-heading').slice(0, 2)).toEqual(['Sources', 'Playbooks']);
    expect(entry('broken').querySelector('.settings-errors')).not.toBeNull();
    expect(entry('ops').querySelector('.settings-errors')).not.toBeNull();
    expect(entry('build').querySelector('.settings-errors')).toBeNull();

    entry('broken').click();
    await settle();
    expect(texts('.settings-page > .settings-error')).toEqual(['Unknown keys: color.']);
    expect(host.querySelector('.settings-page .settings-message')?.textContent).toBe('Fix this entry in settings.json in an editor, or delete it.');
  });

  it("shows a Codex playbook's sessions setting as auto when settings.json sets no Codex mode, and keeps a playbook's own mode", async () => {
    answers['page-settings-read'] = { status: 200, body: config({ sessions: { provider: 'codex' }, playbooks: { 'dev:build': { description: 'Build it', template: 'Build.' }, 'dev:gh': { description: 'Uses gh', permissionMode: 'bypassPermissions', template: 'Ship.' } } }, {}) };
    await open();

    entry('build').click();
    await settle();
    expect(control<HTMLSelectElement>('permissionMode').options[0]!.textContent).toBe('Sessions setting (auto)');
    expect(control<HTMLSelectElement>('permissionMode').value).toBe('');

    entry('gh').click();
    await settle();
    expect(control<HTMLSelectElement>('permissionMode').value).toBe('bypassPermissions');
  });

  it("draws a task playbook's page: Start and Reports rows, Approve sends while Approval is on, the agent's modes, and the template's variables", async () => {
    await open();
    entry('build').click();
    await settle();

    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('dev:build');
    expect(texts('.settings-caption > label, .settings-caption > span')).toEqual(['Description', 'Kind', 'Start', 'Reports', 'Approve sends the work', 'Working directory', 'Agent', 'Permission mode', 'Model', 'Return of', 'Focus page', 'Prompt']);
    expect(texts('.settings-check label:not(.settings-box)')).toEqual(['Automatically', 'Needs a worktree', 'Done', 'Approval', 'Worktree', 'Playbook', 'Paste']);
    expect([...control<HTMLSelectElement>('permissionMode').options].map((one) => one.textContent)).toEqual(['Sessions setting (auto)', 'default', 'auto', 'plan', 'bypassPermissions']);
    expect(control<HTMLInputElement>('model').placeholder).toBe('Sessions setting (Claude’s default)');
    expect(host.querySelector<HTMLButtonElement>('[data-path="template"] .settings-info')!.title).toBe('Variables: {{ticket.title}}. Switchboard adds the commands for the checked reports, with stage and link.');

    // Codex offers its own modes and its sessions setting.
    pick('provider', 'codex');
    await settle();
    expect([...control<HTMLSelectElement>('permissionMode').options].map((one) => one.textContent)).toEqual(['Sessions setting (default)', 'default', 'bypassPermissions']);

    // Unchecking Approval drops Approve sends with it.
    host.querySelector<HTMLInputElement>('#settings-field-reports_approval')!.click();
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('[data-path="approvalSends"]')).toBeNull();
    expect(checked().playbooks['dev:build']).toEqual({ description: 'Build it', autoStart: true, requiresWorktree: false, reports: ['done'], provider: 'codex', template: 'Build {{ticket.title}}.' });
    expect(entry('build').querySelector('.settings-dirty')).not.toBeNull();
    expect(entry('dev').querySelector('.settings-dirty')).not.toBeNull();

    // Undoing every edit restores the entry as the file has it, so it is no longer unsaved.
    host.querySelector<HTMLInputElement>('#settings-field-reports_approval')!.click();
    await settle();
    host.querySelector<HTMLInputElement>('#settings-field-approvalSends')!.click();
    pick('provider', '');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(checked().playbooks['dev:build']).toEqual(file.playbooks['dev:build']);
    expect(entry('build').querySelector('.settings-dirty')).toBeNull();
    expect(host.querySelector('.settings-status')?.textContent).toBe('');
  });

  it("shows a triage playbook's few fields, and changing the kind to triage drops the task's reports", async () => {
    await open();
    entry('triage').click();
    await settle();
    expect(texts('.settings-caption > label, .settings-caption > span')).toEqual(['Description', 'Kind', 'Rates importance', 'Classifier instructions']);

    entry('build').click();
    await settle();
    pick('kind', 'triage');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(checked().playbooks['dev:build']).toEqual({ description: 'Build it', kind: 'triage', autoStart: true, template: 'Build {{ticket.title}}.' });
  });

  it('places a playbook error on the field it names and the template, and the rest at the top of its page', async () => {
    answers['page-settings-check'] = { status: 200, body: { errors: ['playbooks.dev:build: reports must list known reports.', 'playbooks.dev:build: Unknown template variable: nope.', 'playbooks.dev:build: Something else.'] } };
    await open();
    entry('build').click();
    await settle();

    expect(host.querySelector('[data-path="template"] .settings-field-error')?.textContent).toBe('Unknown template variable: nope.');
    // An error that starts with no field's key, such as one about the reports, shows at the top of the page.
    expect(texts('.settings-page > .settings-error')).toEqual(['reports must list known reports.', 'Something else.']);
    expect(texts('.settings-group .settings-field-error')).toEqual([]);
    expect(entry('General').querySelector('.settings-errors')).toBeNull();
  });

  it("edits a namespace's playbooks in a table: Start, Reports with Sends only beside Approval, Repo root and Rates, with each row's dot and errors", async () => {
    answers['page-settings-check'] = (body) => ({ status: 200, body: { errors: getAt(body['settings'] as never, 'playbooks.dev:triage.rates') === undefined ? ['playbooks.dev:triage: rates is off.'] : [] } });
    await open();
    entry('dev').click();
    await settle();

    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('dev playbooks');
    expect(texts('.settings-table thead tr:first-child th')).toEqual(['', 'Start', 'Reports', '']);
    expect(texts('.settings-table thead tr:last-child th')).toEqual(['Name', 'Auto', 'Needs worktree', 'Done', 'Approval', 'Sends', 'Worktree', 'Playbook', 'Paste', 'Repo root', 'Rates']);

    const row = (name: string) => host.querySelector(`tbody[data-playbook="${name}"]`)!;
    const box = (name: string, label: string) => row(name).querySelector<HTMLInputElement>(`input[aria-label$=": ${label}"]`);

    expect(box('dev:triage', 'Auto')).toBeNull();
    expect(box('dev:build', 'Rates')).toBeNull();
    expect(box('dev:build', 'Sends')!.checked).toBe(true);

    box('dev:build', 'Approval')!.click();
    await settle();
    expect(box('dev:build', 'Sends')!.checked).toBe(false);
    expect(box('dev:build', 'Sends')!.disabled).toBe(true);
    box('dev:build', 'Repo root')!.click();
    box('dev:triage', 'Rates')!.click();
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(checked().playbooks['dev:build']).toMatchObject({ reports: ['done'], workdir: 'repoRoot' });
    expect(row('dev:build').querySelector('.settings-dirty')).not.toBeNull();
    expect(row('dev:triage').querySelector('.settings-field-error')?.textContent).toBe('rates is off.');

    row('dev:triage').querySelector<HTMLButtonElement>('button.link')!.click();
    await settle();
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('dev:triage');
  });

  it('New playbook takes a namespace and a name, keeps its fields out of the file until Create, and Delete asks naming the open work items', async () => {
    await open();
    entry('+ New playbook').click();
    await settle();

    const type = (selector: string, text: string) => {
      const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;

      field.value = text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const press = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.trim() === label)!.click();

    type('[data-path="description"] input', 'Review it');
    expect(host.querySelector('.settings-status')?.textContent).toBe('');
    press('Create');
    await settle();
    expect(host.querySelector('[data-path="new-name"] .settings-field-error')?.textContent).toBe('Namespace and name must be lowercase letters, digits and hyphens.');
    type('#settings-new-namespace', 'dev');
    type('#settings-new-name', 'build');
    expect(host.querySelector('[data-path="new-name"] .settings-field-error')?.textContent).toBe('A playbook named dev:build already exists.');
    type('#settings-new-name', 'review');
    press('Create');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('dev:review');
    expect(checked().playbooks['dev:review']).toEqual({ description: 'Review it', autoStart: false, requiresWorktree: false, template: '' });

    entry('build').click();
    await settle();
    press('Delete');
    await settle();
    expect(host.querySelector('.settings-ask .sheet-title')?.textContent).toBe('Delete playbook dev:build?');
    expect(host.querySelector('.settings-ask .sheet-detail')?.textContent).toBe('2 open work items use it. Save removes it from settings.json.');
    press('Cancel');
    await settle();
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('dev:build');
    expect(document.activeElement?.textContent).toBe('Delete');
    press('Delete');
    await settle();
    [...host.querySelectorAll<HTMLButtonElement>('.settings-ask button')].find((one) => one.textContent === 'Delete')!.click();
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('General');
    expect(document.activeElement).toBe(host.querySelector('.settings-page-title h2'));
    expect('dev:build' in checked().playbooks).toBe(false);
  });
});
