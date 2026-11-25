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

describe('Settings voice and personas (architecture.md § Web page)', () => {
  let host: HTMLElement;
  let posts: Array<{ name: string; body: Record<string, unknown> }>;
  let answers: Record<string, Answer | ((body: Record<string, unknown>) => Answer)>;
  const file = {
    sessions: { installHooks: false },
    voice: { voice: 'cedar', personas: [{ id: 'nova', name: 'Nova' }, { id: 'sage-1', name: 'Sage' }, { id: 'x' }], playbookPersonas: { 'dev:build': 'nova', 'dev:gone': 'x' } },
    playbooks: { 'dev:build': { description: 'B', template: 'x' }, 'dev:review': { description: 'R', template: 'x' }, 'dev:triage': { description: 'T', kind: 'triage', template: 'x' } },
  };
  const idle = { state: 'idle', endsAt: null, error: null, enrolledAt: null };

  beforeEach(() => {
    // A desktop's width, whose navigation opens a group under its entry; the phone's drill-down has tests of its own.
    window.innerWidth = 1280;
    vi.useFakeTimers();
    posts = [];
    answers = { 'page-settings-read': { status: 200, body: config(file) }, 'page-settings-check': { status: 200, body: { errors: [] } }, 'page-voice-enroll': { status: 200, body: { enrollment: idle } } };
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
  const headings = () => [...host.querySelectorAll('.settings-section-heading')].map((node) => (node.querySelector('.settings-toggle-label') ?? node).textContent);
  const entry = (label: string) => {
    const find = () => [...host.querySelectorAll<HTMLButtonElement>('.settings-nav-entry')].find((one) => one.querySelector('.settings-nav-label')?.textContent === label);

    // A group's entries show once it is open: the lists' groups first, then a namespace's, which opens its table.
    for (const selector of ['.settings-nav-entry.group[aria-expanded="false"]:not([data-page])', '.settings-nav-entry.group[aria-expanded="false"]']) {
      let closed: HTMLButtonElement | null;

      while (find() === undefined && (closed = host.querySelector<HTMLButtonElement>(selector)) !== null) {
        closed.click();
      }
    }

    return find()!;
  };
  const control = <T extends HTMLElement>(path: string) => host.querySelector<T>(`[data-path="${path}"] input, [data-path="${path}"] select, [data-path="${path}"] textarea`)!;
  const checked = () => posts.filter((one) => one.name === 'page-settings-check').at(-1)!.body['settings'] as { voice?: Record<string, unknown> };
  const pick = (path: string, value: string) => {
    const box = control<HTMLSelectElement>(path);

    box.value = value;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const type = (path: string, text: string) => {
    const box = control<HTMLInputElement>(path);

    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const press = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.trim() === label)!.click();
  const go = async (label: string) => {
    entry(label).click();
    await vi.advanceTimersByTimeAsync(0);
  };

  it('ends the navigation with Voice: Voice settings, then Personas with each persona by its name or ID, and New persona', async () => {
    await open();

    expect(texts('.settings-nav-heading')).toEqual(['Work', 'Voice']);
    expect(texts('.settings-nav-category:last-child .settings-nav-list > .settings-nav-entry .settings-nav-label')).toEqual(['Voice settings', 'Personas']);
    host.querySelector<HTMLButtonElement>('.settings-nav-entry[data-key="personas"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts('.settings-nav-children[aria-label="Personas"] .settings-nav-label')).toEqual(['Nova', 'Sage', 'x', '+ New persona']);
  });

  it("draws the Voice page's sections, the playbooks' personas with a missing playbook marked, and Assign for a task playbook without one", async () => {
    await open();
    await go('Voice settings');

    expect(headings()).toEqual(['Speech', 'Spoken alerts', 'Dictation', 'Voice check', 'Playbook personas', 'Your voice']);
    expect(control<HTMLSelectElement>('voice.voice').value).toBe('cedar');
    expect([...control<HTMLSelectElement>('voice.voice').options].map((one) => one.textContent).slice(0, 3)).toEqual(['Marin', 'Cedar', 'Alloy']);
    expect(texts('.settings-section:not(.advanced) .settings-caption label').filter((label) => label?.startsWith('dev:'))).toEqual(['dev:build', 'dev:gone (missing)']);
    expect([...control<HTMLSelectElement>('voice.playbookPersonas.dev:build').options].map((one) => one.textContent)).toEqual(['None', 'Nova (nova)', 'Sage (sage-1)', 'x (x)']);
    expect([...host.querySelectorAll<HTMLOptionElement>('#settings-assign-playbook option')].map((one) => one.value)).toEqual(['dev:review']);

    host.querySelector<HTMLSelectElement>('#settings-assign-persona')!.value = 'sage-1';
    press('Assign');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(checked().voice!['playbookPersonas']).toEqual({ 'dev:build': 'nova', 'dev:gone': 'x', 'dev:review': 'sage-1' });
    expect(host.querySelector('.settings-assign-note')?.textContent).toBe('Every task playbook has a persona.');

    // None removes the assignment's row.
    pick('voice.playbookPersonas.dev:gone', '');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('[data-path="voice.playbookPersonas.dev:gone"]')).toBeNull();
    expect(entry('Voice settings').querySelector('.settings-dirty')).not.toBeNull();
    expect(entry('Nova').querySelector('.settings-dirty')).toBeNull();
  });

  it("marks a persona's page, not Voice, for an edit of the persona, and notes a name that is a voice's", async () => {
    await open();
    await go('Sage');

    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('Persona sage-1');
    expect(texts('.settings-caption label')).toEqual(['Name', 'Voice', 'Style', 'Personality']);
    expect([...control<HTMLSelectElement>('voice.personas[1].voice').options][0]!.textContent).toBe('Voice setting (Cedar)');
    expect(texts('.settings-note')).toEqual(['Sage is also the name of an OpenAI voice, which makes the settings hard to read. Choose another name.']);

    type('voice.personas[1].name', 'Echo One');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(entry('Echo One').querySelector('.settings-dirty')).not.toBeNull();
    expect(entry('Voice settings').querySelector('.settings-dirty')).toBeNull();
    expect(host.querySelectorAll('.settings-note')).toHaveLength(0);
  });

  it('New persona adds {id} and opens its page; Remove persona drops its assignments and leaves no change when the file had none', async () => {
    answers['page-settings-read'] = { status: 200, body: config({ sessions: { installHooks: false }, playbooks: file.playbooks }) };
    await open();
    await go('+ New persona');

    const name = (text: string) => {
      const box = host.querySelector<HTMLInputElement>('#settings-new-name')!;

      box.value = text;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    };

    name('Nova');
    expect(host.querySelector('[data-path="new-name"] .settings-field-error')?.textContent).toBe('The ID must be lowercase letters, digits and hyphens.');
    name('nova');
    press('Create');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('Persona nova');
    expect(checked().voice).toEqual({ personas: [{ id: 'nova' }] });

    await go('Voice settings');
    press('Assign');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(checked().voice).toEqual({ personas: [{ id: 'nova' }], playbookPersonas: { 'dev:build': 'nova' } });

    await go('nova');
    press('Remove persona');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('Voice');
    expect(checked().voice).toBeUndefined();
    expect(host.querySelector('.settings-bar')).toBeNull();
  });

  it("shows a persona entry's error at the top of its page and a Voice error on its field", async () => {
    answers['page-settings-read'] = { status: 200, body: config({ voice: { personas: ['bad'], speed: 3 } }) };
    answers['page-settings-check'] = { status: 200, body: { errors: ['voice.personas[0] must be an object.', 'voice.speed must be a number from 0.25 to 1.5.'] } };
    await open();

    expect(entry('Persona 1').querySelector('.settings-errors')).not.toBeNull();
    expect(entry('Voice settings').querySelector('.settings-errors')).not.toBeNull();
    await go('Persona 1');
    expect(texts('.settings-page > .settings-error')).toEqual(['voice.personas[0] must be an object.']);
    expect(host.querySelector('.settings-page .settings-message')?.textContent).toBe('Fix this entry in settings.json in an editor, or remove it.');
    await go('Voice settings');
    expect(host.querySelector('[data-path="voice.speed"] .settings-field-error')?.textContent).toBe('voice.speed must be a number from 0.25 to 1.5.');
    expect(host.querySelectorAll('.settings-page > .settings-error')).toHaveLength(0);
  });

  it('keeps a persona page by its ID when a read moves the persona', async () => {
    const pane = await open();

    await go('Sage');
    answers['page-settings-read'] = { status: 200, body: config({ ...file, voice: { ...file.voice, personas: [{ id: 'sage-1', name: 'Sage' }, { id: 'nova', name: 'Nova' }] } }, { settings: { path: 'p', version: 'v2', value: { ...file, voice: { ...file.voice, personas: [{ id: 'sage-1', name: 'Sage' }, { id: 'nova', name: 'Nova' }] } }, error: null } }) };
    await pane.reload();
    expect(pane.state()?.page).toBe('persona:0');
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('Persona sage-1');
  });

  it('reads how enrolment stands on the Voice page, records with the sentences while asking each second, and shows a refusal first', async () => {
    let state = 'idle';

    answers['page-voice-enroll'] = (body) => {
      if (body['action'] === 'start') {
        state = 'recording';
      }

      if (body['action'] === 'status' && state === 'recording' && posts.filter((one) => one.name === 'page-voice-enroll').length > 3) {
        state = 'enrolled';
      }

      return { status: 200, body: { enrollment: { state, endsAt: state === 'recording' ? Date.now() + 60_000 : null, error: null, enrolledAt: state === 'enrolled' ? '2026-11-20T10:00:00.000Z' : null } } };
    };
    await open();
    await go('Voice settings');

    expect(host.querySelector('.settings-enroll-status')?.textContent).toMatch(/^Not enrolled\./);
    press('Enroll my voice');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('.settings-enroll-status')?.textContent).toBe('Recording. Read these sentences aloud in your usual voice, then keep talking: 60 s left.');
    expect(host.querySelectorAll('.settings-enroll-sentences p')).toHaveLength(5);
    expect(host.querySelector('.settings-enroll .sheet-button')?.textContent).toBe('Cancel');
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.querySelector('.settings-enroll-status')?.textContent).toMatch(/^Enrolled 2026-11-20 \d\d:00\./);
    expect(host.querySelector('.settings-enroll .sheet-button')?.textContent).toBe('Enroll again');
    expect(host.querySelectorAll('.settings-enroll-sentences p')).toHaveLength(0);

    answers['page-voice-enroll'] = { status: 409, body: { error: 'Voice is off (voice.enabled).', enrollment: idle } };
    press('Enroll again');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('.settings-enroll-status')?.textContent).toMatch(/^Voice is off \(voice\.enabled\)\. Not enrolled\./);
  });

  it('drops an enrolment answer that a later request or a close overtook', async () => {
    const pending: Array<{ action: unknown; resolve: (answer: Answer) => void }> = [];
    const pane = settings(host, {
      post: (name, body) => {
        posts.push({ name, body });

        if (name !== 'page-voice-enroll') {
          const answer = answers[name];

          return Promise.resolve(typeof answer === 'function' ? answer(body) : (answer ?? { status: 404, body: {} }));
        }

        return new Promise<Answer>((resolve) => pending.push({ action: body['action'], resolve }));
      },
    });
    const enrolment = (state: string, enrolledAt: string | null = null): Answer => ({ status: 200, body: { enrollment: { state, endsAt: null, error: null, enrolledAt } } });

    pane.open();
    await vi.advanceTimersByTimeAsync(0);
    await go('Voice settings');
    expect(pending.map((one) => one.action)).toEqual(['status']);
    press('Enroll my voice');
    await vi.advanceTimersByTimeAsync(0);
    // The start's answer comes first, then the older status's, which must not replace it.
    pending[1]!.resolve(enrolment('cancelled'));
    await vi.advanceTimersByTimeAsync(0);
    pending[0]!.resolve(enrolment('idle', '2026-11-20T10:00:00.000Z'));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('.settings-enroll-status')?.textContent).toMatch(/^Enrolment cancelled\. Not enrolled\./);

    // An answer that comes after Settings closed and opened again is dropped too.
    press('Enroll my voice');
    await vi.advanceTimersByTimeAsync(0);
    pane.requestClose();
    pane.open();
    await vi.advanceTimersByTimeAsync(0);
    await go('Voice settings');
    pending[2]!.resolve(enrolment('recording'));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('.settings-enroll-status')?.textContent).toBe('Reading whether your voice is enrolled…');
    pending[3]!.resolve(enrolment('idle'));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('.settings-enroll-status')?.textContent).toMatch(/^Not enrolled\./);
  });
});
