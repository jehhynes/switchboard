import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_DELAY_MS, settings } from '../src/settings.js';

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

describe('Settings schedules (architecture.md § Web page)', () => {
  let host: HTMLElement;
  let posts: Array<{ name: string; body: Record<string, unknown> }>;
  const file = {
    sessions: { installHooks: false },
    schedules: { weekly: { playbook: 'dev:clean', repoRoot: 'D:/r', every: 'week', day: 'fri', at: '09:00' }, adhoc: { playbook: 'dev:gone', repoRoot: 'D:/r' } },
    playbooks: { 'dev:clean': { description: 'Clean', template: 'x' }, 'dev:triage': { description: 'T', kind: 'triage', template: 'x' } },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    posts = [];
    host = document.createElement('div');
    document.body.replaceChildren(host);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const open = async (errors: (settings: unknown) => string[] = () => []) => {
    const answers: Record<string, Answer | ((body: Record<string, unknown>) => Answer)> = {
      'page-settings-read': { status: 200, body: config(file) },
      'page-settings-check': (body) => ({ status: 200, body: { errors: errors(body['settings']) } }),
    };
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
  const checked = () => posts.filter((one) => one.name === 'page-settings-check').at(-1)!.body['settings'] as { schedules: Record<string, unknown> };
  const pick = (path: string, value: string) => {
    const box = control<HTMLSelectElement>(path);

    box.value = value;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const press = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.trim() === label)!.click();

  it('lists the schedules in file order under Schedules with New schedule, after the playbooks', async () => {
    await open();

    const labels = texts('.settings-nav-entry .settings-nav-label');

    expect(texts('.settings-nav-heading').slice(0, 3)).toEqual(['Sources', 'Playbooks', 'Schedules']);
    expect(labels.slice(labels.indexOf('+ New playbook') + 1, labels.indexOf('+ New schedule') + 1)).toEqual(['weekly', 'adhoc', '+ New schedule']);
  });

  it("shows the day and time only for the period that uses them, and a new period drops the old one's day, and by hand its time", async () => {
    await open();
    entry('weekly').click();
    await vi.advanceTimersByTimeAsync(0);

    expect(texts('.settings-caption label')).toEqual(['Playbook', 'Repo root', 'Runs', 'Day', 'Time']);
    // Only task playbooks run on a schedule.
    expect([...control<HTMLSelectElement>('schedules.weekly.playbook').options].map((one) => one.value)).toEqual(['', 'dev:clean']);
    expect([...control<HTMLSelectElement>('schedules.weekly.day').options].map((one) => one.value)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    expect(control<HTMLSelectElement>('schedules.weekly.day').value).toBe('fri');

    pick('schedules.weekly.every', 'month');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(texts('.settings-caption label')).toEqual(['Playbook', 'Repo root', 'Runs', 'Day of the month', 'Time']);
    expect(control<HTMLInputElement>('schedules.weekly.day').value).toBe('');
    expect(checked().schedules['weekly']).toEqual({ playbook: 'dev:clean', repoRoot: 'D:/r', every: 'month', at: '09:00' });

    pick('schedules.weekly.every', '');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(texts('.settings-caption label')).toEqual(['Playbook', 'Repo root', 'Runs']);
    expect(checked().schedules['weekly']).toEqual({ playbook: 'dev:clean', repoRoot: 'D:/r' });

    // A playbook the file no longer has stays chosen, marked missing.
    entry('adhoc').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(control<HTMLSelectElement>('schedules.adhoc.playbook').selectedOptions[0]?.textContent).toBe('dev:gone (missing)');
  });

  it('New schedule refuses a taken name and adds an empty entry; Remove schedule takes it out of the draft and opens General', async () => {
    await open();
    entry('+ New schedule').click();
    await vi.advanceTimersByTimeAsync(0);

    const name = (text: string) => {
      const box = host.querySelector<HTMLInputElement>('#settings-new-name')!;

      box.value = text;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    };

    name('weekly');
    expect(host.querySelector('[data-path="new-name"] .settings-field-error')?.textContent).toBe('A schedule named weekly already exists.');
    name('Nightly');
    press('Create');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('[data-path="new-name"] .settings-field-error')?.textContent).toBe('The name must be lowercase letters, digits and hyphens.');
    name('nightly');
    press('Create');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('nightly');
    expect(checked().schedules['nightly']).toEqual({});
    expect(entry('nightly').querySelector('.settings-dirty')).not.toBeNull();

    press('Remove schedule');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('General');
    expect('nightly' in checked().schedules).toBe(false);
    expect(host.querySelector('.settings-status')?.textContent).toBe('');
  });

  it("places the hub's errors for an incomplete schedule on its fields and its page, and Save refuses while they stand", async () => {
    await open((settings) => {
      const nightly = (settings as { schedules?: Record<string, Record<string, unknown>> }).schedules?.['nightly'];

      return nightly === undefined ? [] : ['schedules.nightly: playbook and repoRoot are required.', ...(nightly['every'] === 'month' && nightly['day'] === undefined ? ['schedules.nightly.day must be a whole number from 1 to 31.'] : [])];
    });
    entry('+ New schedule').click();
    await vi.advanceTimersByTimeAsync(0);

    const box = host.querySelector<HTMLInputElement>('#settings-new-name')!;

    box.value = 'nightly';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    press('Create');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    // An error that names the schedule shows on its first field.
    expect(host.querySelector('[data-path="schedules.nightly.playbook"] .settings-field-error')?.textContent).toBe('schedules.nightly: playbook and repoRoot are required.');
    expect(entry('nightly').querySelector('.settings-errors')).not.toBeNull();

    pick('schedules.nightly.every', 'month');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('[data-path="schedules.nightly.day"] .settings-field-error')?.textContent).toBe('schedules.nightly.day must be a whole number from 1 to 31.');
    expect(host.querySelector('.settings-status')?.textContent).toBe('Unsaved changes · 2 errors');

    press('Save');
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.some((one) => one.name === 'page-settings-save')).toBe(false);
    expect(texts('.settings-bar .settings-error')).toHaveLength(2);
  });
});
