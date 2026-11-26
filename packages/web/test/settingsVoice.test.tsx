import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
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

  const headings = () => [...host.querySelectorAll('.settings-section-heading')].map((node) => (node.querySelector('.settings-toggle-label') ?? node).textContent);
  const go2 = async (key: string) => {
    host.querySelector<HTMLButtonElement>(`.settings-nav-entry[data-key="${key}"]`)!.click();
    await vi.advanceTimersByTimeAsync(0);
  };

  it('ends the navigation with Voice: Spoken replies, Dictation, then Personas, which opens its page and lists each persona by its name or ID', async () => {
    await open();

    expect(texts('.settings-nav-heading')).toEqual(['Work', 'App', 'Voice']);
    expect(texts('.settings-nav-category:last-child .settings-nav-list > .settings-nav-entry .settings-nav-label')).toEqual(['Spoken replies', 'Dictation', 'Personas']);
    expect(host.querySelector('.settings-nav-entry[data-key="personas"] .settings-nav-count')?.textContent).toBe('3');
    await go2('personas');
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('Personas');
    expect(texts('.settings-nav-children[aria-label="Personas"] .settings-nav-label')).toEqual(['Nova', 'Sage', 'x', '+ New persona']);
  });

  it('draws Spoken replies: the voice switch and speaker, replies, and spoken alerts dimmed under a line to the switch while the voice is off', async () => {
    await open();
    await go2('spoken-replies');

    expect(host.querySelector('.settings-page-title h2')?.firstChild?.textContent).toBe('Spoken replies');
    expect(host.querySelector('.settings-page-title h2 .settings-experimental')?.textContent).toBe('Experimental');
    expect(host.querySelector('.settings-experimental-note')?.textContent).toBe('Spoken replies may be unreliable. Replies are spoken only after you turn them on in a conversation’s View options; spoken alerts have their own switch below.');
    expect(host.querySelector('.settings-lede')?.textContent).toBe('Switchboard speaks replies and alerts to you.');
    expect(headings()).toEqual(['Voice', 'Replies', 'Spoken alerts']);
    expect(texts('.settings-caption > label, .settings-caption > span')).toEqual(['Use voice', 'Speaker', 'Voice', 'Style', 'Speed', 'Expressive delivery', 'Stop speaking when you are away for', 'Spoken alerts', 'Your name', 'Alert when', 'Answer window']);
    // The three Alert when boxes are one row.
    expect(texts('.settings-row.group .settings-check label:not(.settings-box)')).toEqual(['A turn finishes', 'A question', 'A permission prompt']);
    expect(control<HTMLSelectElement>('voice.voice').value).toBe('cedar');
    expect([...control<HTMLSelectElement>('voice.voice').options].map((one) => one.textContent).slice(0, 3)).toEqual(['Marin', 'Cedar', 'Alloy']);
    // Only Spoken alerts needs the voice on; the line leads to the switch.
    expect([...host.querySelectorAll('.settings-card.dimmed')].map((card) => card.closest('.settings-section')?.querySelector('.settings-section-heading')?.textContent)).toEqual(['Spoken alerts']);
    expect(host.querySelectorAll('.settings-voice-off')).toHaveLength(1);
    press('Turn on voice');
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).toBe(control('voice.enabled'));
    control<HTMLInputElement>('voice.enabled').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('.settings-card.dimmed')).toBeNull();
    expect(host.querySelector('.settings-voice-off')).toBeNull();
  });

  it("draws Dictation: the microphone with the enrolment, dictation, talking over replies, someone else speaking, and the match threshold under Advanced, without the pitch check's factors", async () => {
    await open();
    await go2('dictation');

    expect(host.querySelector('.settings-lede')?.textContent).toBe('You speak to Switchboard: the microphone, dictation and your voice.');
    expect(headings()).toEqual(['Microphone', 'Dictation', 'When you speak over a spoken reply', 'Another person speaks near the mic', 'Advanced']);
    expect(texts('.settings-section:not(.advanced) .settings-caption > label, .settings-section:not(.advanced) .settings-caption > span')).toEqual(['Microphone', 'Your voice', 'End of message after', 'Stop dictation after', 'On this computer', 'Over Remote Desktop', 'Resume dictation after', 'Hold dictation', 'Hold for']);
    expect([...control<HTMLSelectElement>('voice.duplex.local').options].map((one) => one.textContent)).toEqual(['Auto', 'Keep dictation on', 'Pause dictation']);
    expect(texts('[data-path="voice.endPauseMs"] .settings-unit')).toEqual(['ms']);
    expect(host.querySelector('.settings-enroll')?.closest('.settings-section')?.querySelector('.settings-section-heading')?.textContent).toBe('Microphone');
    // The whole page needs the voice, so it says it is off once, above its dimmed sections.
    expect(host.querySelectorAll('.settings-voice-off')).toHaveLength(1);
    expect(host.querySelector('.settings-page > .settings-voice-off')).not.toBeNull();
    expect(host.querySelectorAll('.settings-card.dimmed')).toHaveLength(4);
    host.querySelector<HTMLButtonElement>('.settings-toggle')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts('.settings-section.advanced .settings-caption label')).toEqual(['Voice match threshold']);
    // The pitch check's factors are settings.json only.
    expect(host.querySelector('[data-path^="voice.pitch"]')).toBeNull();
  });

  it("shows an error in the pitch check's factors at the top of Dictation, saying where to fix it", async () => {
    answers['page-settings-check'] = { status: 200, body: { errors: ['voice.pitchLowFactor must be a number from 1 to 3.'] } };
    await open();

    expect(entry('Dictation').querySelector('.settings-errors')).not.toBeNull();
    expect(host.querySelector('.settings-page > .settings-error')).toBeNull();
    await go2('dictation');
    expect(texts('.settings-page > .settings-error')).toEqual(['voice.pitchLowFactor must be a number from 1 to 3. Fix it in settings.json: C:/home/.switchboard/settings.json']);
  });

  it('keeps each voice setting on its settings.json key: an edit on Spoken replies or Dictation drafts the same key and marks that page alone', async () => {
    await open();

    const moved: Array<[page: string, path: string, input: string | boolean, value: unknown]> = [
      ['spoken-replies', 'voice.enabled', true, true],
      ['spoken-replies', 'voice.outputDevice', 'Speakers', 'Speakers'],
      ['spoken-replies', 'voice.style', 'pair', 'pair'],
      ['spoken-replies', 'voice.speed', '1.25', 1.25],
      ['spoken-replies', 'voice.expressive', true, true],
      ['spoken-replies', 'voice.awayMinutes', '5', 5],
      ['spoken-replies', 'voice.spokenAlerts', false, false],
      ['spoken-replies', 'voice.operatorName', 'Alex', 'Alex'],
      ['spoken-replies', 'voice.alertOn.question', false, false],
      ['spoken-replies', 'voice.alertAnswerSeconds', '20', 20],
      ['dictation', 'voice.inputDevice', 'Headset', 'Headset'],
      ['dictation', 'voice.endPauseMs', '2000', 2000],
      ['dictation', 'voice.micIdleMinutes', '0', 0],
      ['dictation', 'voice.duplex.local', 'full', 'full'],
      ['dictation', 'voice.duplex.remote', 'half', 'half'],
      ['dictation', 'voice.halfDuplexTailMs', '500', 500],
      ['dictation', 'voice.roomHold', false, false],
      ['dictation', 'voice.roomHoldSeconds', '30', 30],
      ['dictation', 'voice.matchThreshold', '0.5', 0.5],
    ];

    for (const [page, path, input, value] of moved) {
      await go2(page);

      for (const toggle of host.querySelectorAll<HTMLButtonElement>('.settings-toggle[aria-expanded="false"]')) {
        toggle.click();
      }

      await vi.advanceTimersByTimeAsync(0);

      const box = control<HTMLInputElement & HTMLSelectElement>(path);

      if (typeof input === 'boolean') {
        box.click();
      } else {
        box.value = input;
        box.dispatchEvent(new Event(box.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      }

      await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
      expect(getAt(checked() as never, path), path).toEqual(value);
      expect(texts('.settings-nav-entry:not(.group):has(.settings-dirty) .settings-nav-label'), path).toEqual([page === 'spoken-replies' ? 'Spoken replies' : 'Dictation']);
      press('Discard');
      await vi.advanceTimersByTimeAsync(0);
      await open();
    }
  });

  it("assigns personas from the Personas page's table by namespace and from a playbook's page, both editing one draft, None removing the entry and a missing playbook's entry removable", async () => {
    await open();
    await go2('personas');

    expect(headings()).toEqual(['dev', 'Missing playbooks']);
    expect(texts('.settings-caption label')).toEqual(['build', 'review', 'dev:gone (missing)']);
    expect([...control<HTMLSelectElement>('voice.playbookPersonas.dev:build').options].map((one) => one.textContent)).toEqual(['None', 'Nova', 'Sage', 'x']);
    // A persona shows by its name alone, its ID in the tooltip.
    expect([...control<HTMLSelectElement>('voice.playbookPersonas.dev:build').options].map((one) => one.title)).toEqual(['', 'nova', 'sage-1', 'x']);
    expect(control<HTMLSelectElement>('voice.playbookPersonas.dev:build').value).toBe('nova');
    expect(control<HTMLSelectElement>('voice.playbookPersonas.dev:review').value).toBe('');

    pick('voice.playbookPersonas.dev:review', 'sage-1');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(checked().voice!['playbookPersonas']).toEqual({ 'dev:build': 'nova', 'dev:gone': 'x', 'dev:review': 'sage-1' });
    expect(entry('Personas').querySelector('.settings-dirty')).not.toBeNull();

    // A missing playbook's entry goes with None.
    pick('voice.playbookPersonas.dev:gone', '');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('[data-path="voice.playbookPersonas.dev:gone"]')).toBeNull();
    expect(headings()).toEqual(['dev']);

    // The playbook's page shows the same draft under Run as, and its edit shows on the table.
    entry('review').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(control<HTMLSelectElement>('voice.playbookPersonas.dev:review').value).toBe('sage-1');
    expect(control('voice.playbookPersonas.dev:review').closest('.settings-section')?.querySelector('.settings-section-heading')?.textContent).toBe('Run as');
    expect(entry('review').querySelector('.settings-dirty')).not.toBeNull();
    pick('voice.playbookPersonas.dev:review', '');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(checked().voice!['playbookPersonas']).toEqual({ 'dev:build': 'nova' });
    // Back as the file has it, the playbook is no longer unsaved; Personas still is, for the missing entry removed.
    expect(entry('review').querySelector('.settings-dirty')).toBeNull();
    await go2('personas');
    expect(control<HTMLSelectElement>('voice.playbookPersonas.dev:review').value).toBe('');
    expect(entry('Personas').querySelector('.settings-dirty')).not.toBeNull();
    // A triage playbook takes no persona.
    expect(host.querySelector('[data-path="voice.playbookPersonas.dev:triage"]')).toBeNull();
    entry('triage').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('[data-path^="voice.playbookPersonas."]')).toBeNull();
  });

  it("marks a playbook and the lists around it for an error in its persona, and its page removes an assignment to a missing persona with no roster", async () => {
    answers['page-settings-read'] = { status: 200, body: config({ voice: { playbookPersonas: { 'dev:build': 'gone' } }, playbooks: file.playbooks }) };
    answers['page-settings-check'] = (body) => ({ status: 200, body: { errors: getAt(body['settings'] as never, 'voice.playbookPersonas.dev:build') === undefined ? [] : ['voice.playbookPersonas.dev:build names a persona not in voice.personas.'] } });
    await open();

    expect(host.querySelector('.settings-nav-entry[data-key="playbooks"] .settings-errors')).not.toBeNull();
    entry('build').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(entry('build').querySelector('.settings-errors')).not.toBeNull();
    expect(entry('dev').querySelector('.settings-errors')).not.toBeNull();
    expect([...control<HTMLSelectElement>('voice.playbookPersonas.dev:build').options].map((one) => one.textContent)).toEqual(['None', 'gone (missing)']);
    expect(host.querySelector('[data-path="voice.playbookPersonas.dev:build"] .settings-field-error')?.textContent).toBe('voice.playbookPersonas.dev:build names a persona not in voice.personas.');
    pick('voice.playbookPersonas.dev:build', '');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(checked().voice).toEqual({ playbookPersonas: {} });
    expect(entry('build').querySelector('.settings-errors')).toBeNull();
    // With no roster and no assignment, the playbook has no persona to choose.
    expect(host.querySelector('[data-path="voice.playbookPersonas.dev:build"]')).toBeNull();
  });

  it('marks only the playbook a persona error names exactly, and removes a non-ID assignment from the playbook page with no roster', async () => {
    const playbooks = { 'dev:build': { description: 'B', template: 'x' }, 'dev:build-extra': { description: 'E', template: 'x' } };

    answers['page-settings-read'] = { status: 200, body: config({ voice: { playbookPersonas: { 'dev:build': 42 } }, playbooks }) };
    // No roster at first; a persona whose ID is the number's text comes later.
    answers['page-settings-check'] = { status: 200, body: { errors: ['voice.playbookPersonas.dev:build-extra names a persona not in voice.personas.'] } };
    await open();

    expect(entry('build-extra').querySelector('.settings-errors')).not.toBeNull();
    expect(entry('build').querySelector('.settings-errors')).toBeNull();
    entry('build').click();
    await vi.advanceTimersByTimeAsync(0);
    expect([...control<HTMLSelectElement>('voice.playbookPersonas.dev:build').selectedOptions].map((one) => one.textContent)).toEqual(['42 (invalid)']);
    expect([...control<HTMLSelectElement>('voice.playbookPersonas.dev:build').options].map((one) => one.textContent)).toEqual(['None', '42 (invalid)']);
    pick('voice.playbookPersonas.dev:build', '');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(checked().voice).toEqual({ playbookPersonas: {} });

    // A null shows as itself too.
    answers['page-settings-read'] = { status: 200, body: config({ voice: { playbookPersonas: { 'dev:build': null } }, playbooks }) };
    press('Discard');
    await open();
    entry('build').click();
    await vi.advanceTimersByTimeAsync(0);
    expect([...control<HTMLSelectElement>('voice.playbookPersonas.dev:build').selectedOptions].map((one) => one.textContent)).toEqual(['null (invalid)']);

    // A persona whose ID is the number's text is a choice of its own, which replaces the number.
    answers['page-settings-read'] = { status: 200, body: config({ voice: { personas: [{ id: '42' }], playbookPersonas: { 'dev:build': 42 } }, playbooks }) };
    host.querySelector<HTMLButtonElement>('.settings-close')!.click();
    await open();
    entry('build').click();
    await vi.advanceTimersByTimeAsync(0);
    expect([...control<HTMLSelectElement>('voice.playbookPersonas.dev:build').selectedOptions].map((one) => one.textContent)).toEqual(['42 (invalid)']);
    pick('voice.playbookPersonas.dev:build', '42');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(checked().voice!['playbookPersonas']).toEqual({ 'dev:build': '42' });
  });

  it("marks a persona's page, not Personas, for an edit of the persona, and notes a name that is a voice's", async () => {
    await open();
    await go('Sage');

    // The page is titled by the persona's one name, its ID under it, and lists the playbooks that take it.
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('Sage');
    expect(host.querySelector('.settings-lede')?.textContent).toBe('ID sage-1, by which sessions and playbooks name it.');
    expect(texts('.settings-caption label')).toEqual(['Name', 'Voice', 'Style', 'Personality']);
    expect(texts('.settings-section-heading')).toEqual(['Used by']);
    expect(texts('.settings-used-by .settings-help')).toEqual(['No playbook takes this persona. Give it one on the Personas page or a playbook\'s page.']);
    expect([...control<HTMLSelectElement>('voice.personas[1].voice').options][0]!.textContent).toBe('From Spoken replies: Cedar');
    expect(texts('.settings-note')).toEqual(['Sage is also the name of an OpenAI voice, which makes the settings hard to read. Choose another name.']);

    type('voice.personas[1].name', 'Echo One');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(entry('Echo One').querySelector('.settings-dirty')).not.toBeNull();
    expect(host.querySelector('.settings-nav-entry[data-key="persona:0"] .settings-dirty')).toBeNull();
    expect(host.querySelector('.settings-nav-entry[data-key="spoken-replies"] .settings-dirty')).toBeNull();
    expect(host.querySelectorAll('.settings-note')).toHaveLength(0);
  });

  it("lists on a persona's page the playbooks that take it, each opening its page", async () => {
    await open();
    await go('Nova');

    expect(texts('.settings-used-by button')).toEqual(['dev:build']);
    press('dev:build');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('dev:build');
    expect(control<HTMLSelectElement>('voice.playbookPersonas.dev:build').value).toBe('nova');
  });

  it("on a phone, Back from a playbook reached by a persona's Used by link goes up the playbook's own lists, not the persona's", async () => {
    vi.stubGlobal('screen', { width: 390, height: 844 });
    window.innerWidth = 844;
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    await open();
    await go2('personas');
    await go2('persona:0');
    press('dev:build');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('dev:build');
    host.querySelector<HTMLButtonElement>('.settings-back')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts('.settings-nav-heading')).toEqual(['dev']);
    host.querySelector<HTMLButtonElement>('.settings-back')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts('.settings-nav-heading')).toEqual(['Playbooks']);
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
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('nova');
    expect(checked().voice).toEqual({ personas: [{ id: 'nova' }] });

    await go2('personas');
    pick('voice.playbookPersonas.dev:build', 'nova');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(checked().voice).toEqual({ personas: [{ id: 'nova' }], playbookPersonas: { 'dev:build': 'nova' } });

    await go('nova');
    press('Remove persona');
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('Personas');
    expect(host.querySelector('.settings-page .settings-message')?.textContent).toBe('Add a persona with New persona to give a playbook its own.');
    expect(checked().voice).toBeUndefined();
    expect(host.querySelector('.settings-bar')).toBeNull();
  });

  it("shows a persona entry's error at the top of its page and a voice error on its field on Spoken replies", async () => {
    answers['page-settings-read'] = { status: 200, body: config({ voice: { personas: ['bad'], speed: 3 } }) };
    answers['page-settings-check'] = { status: 200, body: { errors: ['voice.personas[0] must be an object.', 'voice.speed must be a number from 0.25 to 1.5.'] } };
    await open();

    expect(host.querySelector('.settings-nav-entry[data-key="personas"] .settings-errors')).not.toBeNull();
    expect(entry('Spoken replies').querySelector('.settings-errors')).not.toBeNull();
    await go('Persona 1');
    expect(texts('.settings-page > .settings-error')).toEqual(['voice.personas[0] must be an object. Fix it in settings.json: C:/home/.switchboard/settings.json']);
    expect(host.querySelector('.settings-page .settings-message')?.textContent).toBe('Fix this entry in settings.json in an editor, or remove it.');
    await go2('spoken-replies');
    expect(host.querySelector('[data-path="voice.speed"] .settings-field-error')?.textContent).toBe('voice.speed must be a number from 0.25 to 1.5.');
    expect(host.querySelectorAll('.settings-page > .settings-error')).toHaveLength(0);
  });

  it('keeps a persona page by its ID when a read moves the persona', async () => {
    const pane = await open();

    await go('Sage');
    answers['page-settings-read'] = { status: 200, body: config({ ...file, voice: { ...file.voice, personas: [{ id: 'sage-1', name: 'Sage' }, { id: 'nova', name: 'Nova' }] } }, { settings: { path: 'p', version: 'v2', value: { ...file, voice: { ...file.voice, personas: [{ id: 'sage-1', name: 'Sage' }, { id: 'nova', name: 'Nova' }] } }, error: null } }) };
    await pane.reload();
    expect(pane.state()?.page).toBe('persona:0');
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('Sage');
  });

  it('reads how enrolment stands on Dictation, records with the sentences while asking each second, and shows a refusal first', async () => {
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
    await go2('dictation');

    expect(host.querySelector('.settings-enroll-status')?.textContent).toMatch(/^Not enrolled\./);
    press('Enroll my voice');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('.settings-enroll-status')?.textContent).toBe('Recording. Read these sentences aloud in your usual voice, then keep speaking: 60 s left.');
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
    await go2('dictation');
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
    await go2('dictation');
    pending[2]!.resolve(enrolment('recording'));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('.settings-enroll-status')?.textContent).toBe('Reading whether your voice is enrolled…');
    pending[3]!.resolve(enrolment('idle'));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('.settings-enroll-status')?.textContent).toMatch(/^Not enrolled\./);
  });
});
