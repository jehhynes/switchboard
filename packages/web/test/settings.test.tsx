import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { CHECK_DELAY_MS, settings } from '../src/settings.js';
import { bar, EditorState, errorPages, fieldOfError, getAt, parseConfig, readField, setAt, withCurrent, sourceFields, sourceTitle } from '../src/settingsModel.js';

type Answer = { status: number; body: Record<string, unknown> };

const config = (value: unknown, patch: Record<string, unknown> = {}) => ({
  settings: { path: 'C:/home/.switchboard/settings.json', version: 'v1', value, error: null },
  permissionModes: ['default', 'auto', 'plan', 'bypassPermissions'],
  codexPermissionModes: ['default', 'bypassPermissions'],
  providers: ['claude', 'codex'],
  templateVariables: ['ticket.title'],
  sourceKinds: ['github', 'zoho', 'forum'],
  sourceLabels: { github: 'GitHub', zoho: 'Zoho Desk', forum: 'Forum' },
  inUse: {},
  enabled: {},
  configDir: 'C:/home/.switchboard',
  ...patch,
});

describe('the Settings model (settingsModel.ts)', () => {
  it('uses a plugin’s declared label and typed fields, skipping malformed descriptions', () => {
    const state = new EditorState(parseConfig(config({ sources: { helpdesk: { kind: 'forum' } } }, {
      sourceLabels: { forum: 'Community' },
      sourceFields: { forum: [null, { key: 'bad', label: 'Bad', type: 'object' }, { key: 'userId', label: 'User', type: 'text', help: 'Your ID' }, { key: 'limit', label: 'Limit', type: 'integer', placeholder: '20', advanced: true }, { key: 'enabled', label: 'Enabled', type: 'boolean', placeholder: 'true' }, { key: 'names', label: 'Names', type: 'list' }] },
    })));
    expect(sourceTitle(state, 'helpdesk')).toBe('helpdesk (Community)');
    const sections = sourceFields(state, 'helpdesk');
    expect(sections.map(section => section.heading)).toEqual(['Connection', 'Work', 'Advanced']);
    expect(sections[0]!.fields.map(field => [field.path, field.kind])).toEqual([['sources.helpdesk.userId', 'text'], ['sources.helpdesk.enabled', 'boolean'], ['sources.helpdesk.names', 'list']]);
    expect(sections[0]!.fields[1]!.fallback).toBe(true);
    // Advanced holds the rarely changed kind, then the plugin's advanced fields.
    expect(sections[2]!.fields.map(field => field.path)).toEqual(['sources.helpdesk.kind', 'sources.helpdesk.limit']);
    expect(sections[2]!.fields[1]).toMatchObject({ path: 'sources.helpdesk.limit', kind: 'integer', placeholder: '20' });
  });

  it('offers configurable Zoho scope and pool fields with no organization defaults', () => {
    const state = new EditorState(parseConfig(config({ sources: { zoho: {} } })));
    const fields = sourceFields(state, 'zoho').flatMap(section => section.fields);
    expect(fields.map(field => field.path)).toEqual(expect.arrayContaining(['sources.zoho.tokenCommand', 'sources.zoho.scopeField', 'sources.zoho.scopeValue', 'sources.zoho.poolTeams', 'sources.zoho.scopeHistoryField', 'sources.zoho.contextFields', 'sources.zoho.historyFields']));
    expect(fields.some(field => field.path.includes('escalation'))).toBe(false);
    expect(fields.find(field => field.path === 'sources.zoho.automationAgentIds')!.listDefault).toBeUndefined();
    expect(fields.find(field => field.path === 'sources.zoho.tokenCommand')!.placeholder).toBeUndefined();
  });

  it('reads and sets dotted paths, list entries and a playbook persona key with a dot, leaving the input unchanged', () => {
    const root = { voice: { personas: [{ id: 'nova' }], playbookPersonas: { 'dev:a.b': 'nova' } } };

    expect(getAt(root, 'voice.personas[0].id')).toBe('nova');
    expect(getAt(root, 'voice.personas[1].id')).toBeUndefined();
    expect(getAt(root, 'voice.playbookPersonas.dev:a.b')).toBe('nova');
    expect(setAt(root, 'sessions.codex.model', 'gpt')).toEqual({ ...root, sessions: { codex: { model: 'gpt' } } });
    expect(setAt(root, 'voice.personas[0].name', 'Nova')).toEqual({ voice: { personas: [{ id: 'nova', name: 'Nova' }], playbookPersonas: { 'dev:a.b': 'nova' } } });
    // A list entry that is missing changes nothing.
    expect(setAt(root, 'voice.personas[3].name', 'Nova')).toEqual(root);
    expect(setAt(root, 'voice.personas[0]', undefined)).toEqual({ voice: { personas: [], playbookPersonas: { 'dev:a.b': 'nova' } } });
    expect(setAt(root, 'voice.playbookPersonas.dev:a.b', undefined)).toEqual({ voice: { personas: [{ id: 'nova' }], playbookPersonas: {} } });
    expect(root.voice.personas).toEqual([{ id: 'nova' }]);
  });

  it('reads a field\'s input: empty removes the key, and text that is no number is kept for the check to name', () => {
    expect(readField('integer', ' 3 ')).toBe(3);
    expect(readField('integer', '3.5')).toBe('3.5');
    expect(readField('integer', '')).toBeUndefined();
    expect(readField('number', '1.25')).toBe(1.25);
    expect(readField('number', 'fast')).toBe('fast');
    expect(readField('boolean', '', true)).toBe(true);
    expect(readField('list', ' a \n\n b ')).toEqual(['a', 'b']);
    expect(readField('list', '')).toBeUndefined();
    expect(readField('list', '', false, true)).toEqual([]);
    expect(readField('text', '')).toBeUndefined();
    expect(readField('prompt', ' kept as typed ')).toBe(' kept as typed ');
  });

  it('places an error on the field whose path it names, by the longest path, a source\'s parent path naming its first field', () => {
    const paths = ['sessions.model', 'sessions.codex.model', 'sources.gh.kind', 'sources.gh.repo'];

    expect(fieldOfError('sessions.codex.model must be a string.', paths)).toBe('sessions.codex.model');
    expect(fieldOfError('sessions.model must be a string.', paths)).toBe('sessions.model');
    expect(fieldOfError('sources.gh: unknown key x.', paths)).toBe('sources.gh.kind');
    expect(fieldOfError('sessions.modelx is unknown.', paths)).toBeNull();
    expect(withCurrent([{ value: 'a', label: 'A' }], 'b')).toEqual([{ value: 'a', label: 'A' }, { value: 'b', label: 'b (missing)' }]);
  });

  it('says Saved only after a save since Settings opened, Unsaved changes while a draft differs, and the errors alone otherwise', () => {
    const state = new EditorState(parseConfig(config({ sessions: { concurrency: 2 } })));

    expect(bar(state)).toMatchObject({ status: '', shown: false, buttons: false });
    state.errors = ['x'];
    expect(bar(state)).toMatchObject({ status: '1 error', shown: true, buttons: false });
    state.errors = [];
    state.warnings = ['dock is no longer used.'];
    expect(bar(state)).toMatchObject({ status: '', shown: true, buttons: false });
    state.warnings = [];
    state.setDraft({ sessions: { concurrency: 3 } });
    expect(bar(state)).toMatchObject({ status: 'Unsaved changes', shown: true, buttons: true, canSave: true });
    // A read of the file that changes nothing is no save.
    state.refresh(parseConfig(config({ sessions: { concurrency: 2 } })));
    expect(bar(state).status).toBe('Unsaved changes');
    state.dropDraft();
    expect(bar(state).status).toBe('');
    state.setDraft({ sessions: { concurrency: 3 } });
    state.wrote({ sessions: { concurrency: 3 } }, 'v2');
    // Saved shows without buttons, since there is nothing to save or discard.
    expect(bar(state)).toMatchObject({ status: 'Saved', shown: true, buttons: false });
    state.setDraft({ sessions: { concurrency: 4 } });
    expect(bar(state).status).toBe('Unsaved changes');
    state.dropDraft();
    expect(bar(state).status).toBe('Saved');
  });

  it("places an error that names a settings.json section but no field on the page that shows that section's settings", () => {
    const state = new EditorState(parseConfig(config({})));

    state.errors = ['web must be an object.', 'sessions must be an object.', 'triage must be an object.', 'alerts must be an object.', 'voice must be an object.', 'voice.pitchLowFactor must be a number from 1 to 3.', 'Unknown key: extra.'];
    expect([...errorPages(state).entries()]).toEqual([
      ['web must be an object.', 'advanced'],
      ['sessions must be an object.', 'sessions'],
      ['triage must be an object.', 'triage'],
      ['alerts must be an object.', 'display'],
      ['voice must be an object.', 'speaking'],
      // The pitch check's factors are settings.json only, so their errors go to Listening, which has the voice check.
      ['voice.pitchLowFactor must be a number from 1 to 3.', 'listening'],
      ['Unknown key: extra.', null],
    ]);
  });

  it('keeps a draft over a read unless it holds no edit, and marks a draft whose file changed on disk', () => {
    const state = new EditorState(parseConfig(config({ sessions: { concurrency: 2 } })));

    state.setDraft({ sessions: { concurrency: 3 } });
    expect(state.dirty).toBe(true);
    state.refresh(parseConfig(config({ sessions: { concurrency: 2 }, triage: {} }, { settings: { path: 'p', version: 'v2', value: { sessions: { concurrency: 2 }, triage: {} }, error: null } })));
    expect(state.draft).toEqual({ sessions: { concurrency: 3 } });
    expect(state.changedOnDisk).toBe(true);
    state.refresh(parseConfig(config({ sessions: { concurrency: 3 } }, { settings: { path: 'p', version: 'v3', value: { sessions: { concurrency: 3 } }, error: null } })));
    expect(state.draft).toBeNull();
  });
});

describe('Settings on the web page (architecture.md § Web page)', () => {
  let host: HTMLElement;
  let posts: Array<{ name: string; body: Record<string, unknown> }>;
  let answers: Record<string, Answer | ((body: Record<string, unknown>) => Answer)>;

  beforeEach(() => {
    // A desktop's width, whose navigation opens a group under its entry; the phone's drill-down has tests of its own.
    window.innerWidth = 1280;
    vi.useFakeTimers();
    posts = [];
    answers = { 'page-settings-read': { status: 200, body: config({ sessions: { installHooks: false } }) }, 'page-settings-check': { status: 200, body: { errors: [] } }, 'page-devices': { status: 200, body: { devices: [] } } };
    host = document.createElement('div');
    document.body.replaceChildren(host);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const start = () => {
    const closed = vi.fn();
    const post = vi.fn(async (name: string, body: Record<string, unknown>) => {
      posts.push({ name, body });

      const answer = answers[name];

      return typeof answer === 'function' ? answer(body) : (answer ?? { status: 404, body: { error: 'not found' } });
    });
    const pane = settings(host, { post, closed });

    return { pane, closed };
  };
  const settle = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  const opened = async () => {
    const started = start();

    started.pane.open();
    await settle();
    return started;
  };
  const field = <T extends HTMLElement>(path: string) => host.querySelector<T>(`[data-path="${path}"] input, [data-path="${path}"] select, [data-path="${path}"] textarea`)!;
  const type = (path: string, text: string) => {
    const box = field<HTMLInputElement>(path);

    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const texts = (selector: string) => [...host.querySelectorAll(selector)].map((node) => node.textContent);
  const headings = () => [...host.querySelectorAll('.settings-section-heading')].map((node) => (node.querySelector('.settings-toggle-label') ?? node).textContent);
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.trim() === label)!;
  const buttonIn = (selector: string, label: string) => [...host.querySelectorAll<HTMLButtonElement>(`${selector} button`)].find((one) => one.textContent?.trim() === label)!;
  const named = (name: string) => posts.filter((one) => one.name === name);
  const go = async (page: string) => {
    host.querySelector<HTMLButtonElement>(`.settings-nav-entry[data-key="${page}"]`)!.click();
    await settle();
  };

  it('reads settings.json and opens on Sessions: the categories, its sections in order with a line under the title, and no bar', async () => {
    await opened();

    expect(named('page-settings-read')).toHaveLength(1);
    expect(texts('.settings-nav-heading')).toEqual(['Work', 'App', 'Voice']);
    expect(texts('.settings-nav-entry .settings-nav-label')).toEqual(['Sessions', 'Triage', 'Sources', 'Playbooks', 'Schedules', 'Alerts and display', 'Devices', 'Advanced', 'Speaking', 'Listening', 'Personas']);
    expect(texts('.settings-nav-entry.group[aria-expanded="false"] .settings-nav-label')).toEqual(['Sources', 'Playbooks', 'Schedules', 'Personas']);
    expect(host.querySelector('.settings-nav-entry.current')?.textContent).toContain('Sessions');
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('Sessions');
    expect(host.querySelector('.settings-lede')?.textContent).toBe('How playbook and ad-hoc sessions run. A playbook can set its own agent, model and permission mode.');
    expect(headings()).toEqual(['All agents', 'Claude', 'Codex']);
    expect(texts('.settings-caption label')).toEqual(['Default agent', 'Concurrency', 'Model', 'Permission mode', 'Model', 'Permission mode']);
    // A clean file has nothing to say, so the bar and its Save and Discard do not show.
    expect(host.querySelector('.settings-bar')).toBeNull();
    expect(button('Save')).toBeUndefined();
    // A field shows its default as its placeholder, and a select its default choice.
    expect(field<HTMLInputElement>('sessions.concurrency').placeholder).toBe('2');
    expect(field<HTMLSelectElement>('sessions.provider').value).toBe('claude');
    expect([...field<HTMLSelectElement>('sessions.provider').options].map((option) => option.textContent)).toEqual(['Claude', 'Codex']);
    expect(field<HTMLSelectElement>('sessions.codex.permissionMode').value).toBe('auto');
    expect(host.querySelector('[data-path^="dock."]')).toBeNull();
  });

  it("draws Triage, Alerts and display, Devices and Advanced, each with its sections, and settings.json's path only on Advanced", async () => {
    await opened();

    const shown = async (page: string) => {
      await go(page);
      return { title: host.querySelector('.settings-page-title h2')?.textContent, headings: headings(), labels: texts('.settings-section:not(.advanced) .settings-caption label') };
    };

    expect(await shown('triage')).toEqual({ title: 'Triage', headings: ['Classifier', 'Advanced'], labels: ['Model', 'Concurrency'] });
    expect(host.querySelector('.settings-toggle-summary')?.textContent).toBe('Timeout (seconds)');
    expect(await shown('display')).toEqual({ title: 'Alerts and display', headings: ['Notifications', 'Replies', 'Diffs'], labels: ['Needs-you alerts from', 'Needs-you sound', 'Collapse details', 'Layout', 'Wrap long lines'] });
    // Spoken alerts are on Speaking, which a line in Notifications opens.
    expect(host.querySelector('.settings-link-row')?.textContent).toBe('Spoken alerts, which the voice says, are on Speaking.Open Speaking');
    host.querySelector<HTMLButtonElement>('.settings-link-row button')!.click();
    await settle();
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('Speaking');
    await go('display');
    expect([...field<HTMLSelectElement>('alerts.surface').options].map((option) => option.textContent)).toEqual(['Web app when open', 'Web page when open', 'System notification']);
    // The diff viewer's layout and wrapping, set once for every page.
    expect([...field<HTMLSelectElement>('web.diffLayout').options].map((one) => one.value)).toEqual(['auto', 'split', 'stacked']);
    expect([...field<HTMLSelectElement>('web.diffWrap').options].map((one) => one.textContent)).toContain('Off');
    expect(await shown('devices')).toEqual({ title: 'Devices', headings: ['Paired devices', 'Remote access', 'Advanced'], labels: ['Tailscale'] });
    expect(host.querySelector('.settings-toggle-summary')?.textContent).toBe('Allowed hosts, Allowed logins');
    expect(await shown('advanced')).toEqual({ title: 'Advanced', headings: ['Experiments', 'Programs', 'Developer', 'Settings file'], labels: ['Code Mode (experimental)', 'Embedded browser tabs', 'Claude Code path', 'Codex path', 'Node.js path', 'Install hooks', 'Friction debriefs'] });
    // Install hooks shows the file's false over its default true.
    expect(field<HTMLInputElement>('sessions.installHooks').checked).toBe(false);
    // The hub keeps the config folder outside settings.json, so Advanced names it and how to change it, without a warning's colour.
    expect(texts('[data-key="settings-file"] .settings-file')).toEqual(['C:/home/.switchboard/settings.json']);
    expect(texts('[data-key="settings-config-folder"] .settings-help')).toEqual(['C:/home/.switchboard', 'Change it with hub.js config set configDir <folder>; Settings then reads the new folder.']);
    expect(host.querySelector('.settings-note')).toBeNull();
    await go('sessions');
    expect(host.querySelector('.settings-file')).toBeNull();
  });

  it('keeps each moved setting on its settings.json key: an edit on its new page drafts the same key, and marks that page alone', async () => {
    await opened();

    const moved: Array<[page: string, path: string, input: string | boolean, value: unknown]> = [
      ['sessions', 'sessions.provider', 'codex', 'codex'],
      ['sessions', 'sessions.concurrency', '3', 3],
      ['sessions', 'sessions.model', 'opus', 'opus'],
      ['sessions', 'sessions.permissionMode', 'plan', 'plan'],
      ['sessions', 'sessions.codex.model', 'gpt', 'gpt'],
      ['sessions', 'sessions.codex.permissionMode', 'bypassPermissions', 'bypassPermissions'],
      ['triage', 'triage.model', 'haiku', 'haiku'],
      ['triage', 'triage.concurrency', '4', 4],
      ['triage', 'triage.timeoutSeconds', '60', 60],
      ['display', 'alerts.surface', 'system', 'system'],
      ['display', 'web.diffLayout', 'split', 'split'],
      ['display', 'web.diffWrap', 'on', 'on'],
      ['display', 'voice.needsYouSound', false, false],
      ['display', 'voice.briefReplies', true, true],
      ['devices', 'web.tailscale', true, true],
      ['devices', 'web.remoteHosts', 'pc.tail.ts.net', ['pc.tail.ts.net']],
      ['devices', 'web.remoteLogins', 'a@b.c', ['a@b.c']],
      ['advanced', 'sessions.codeMode', true, true],
      ['advanced', 'web.iframeBrowser', true, true],
      ['advanced', 'sessions.claudePath', 'C:/claude', 'C:/claude'],
      ['advanced', 'sessions.codexPath', 'C:/codex', 'C:/codex'],
      ['advanced', 'sessions.nodePath', 'C:/node', 'C:/node'],
      ['advanced', 'sessions.installHooks', true, true],
      ['advanced', 'sessions.debriefs', true, true],
    ];

    for (const [page, path, input, value] of moved) {
      await go(page);

      // Advanced sections are opened to reach their fields.
      for (const toggle of host.querySelectorAll<HTMLButtonElement>('.settings-toggle[aria-expanded="false"]')) {
        toggle.click();
      }

      await settle();

      const control = field<HTMLInputElement & HTMLSelectElement>(path);

      if (typeof input === 'boolean') {
        control.click();
      } else {
        control.value = input;
        control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      }

      await settle(CHECK_DELAY_MS);
      expect(getAt(named('page-settings-check').at(-1)!.body['settings'] as never, path), path).toEqual(value);
      // Only the page that shows the key is marked, though Sessions, Devices and Advanced share their settings.json objects.
      expect(texts('.settings-nav-entry:not(.group):has(.settings-dirty) .settings-nav-label'), path).toEqual([host.querySelector(`.settings-nav-entry[data-key="${page}"] .settings-nav-label`)?.textContent]);
      button('Discard').click();
      await settle();
      start().pane.open();
      await settle();
    }
  });

  it('checks the draft 250 ms after the last edit, shows each error on its field and the page in the navigation, and refuses to save while one stands', async () => {
    answers['page-settings-check'] = (body) => ({ status: 200, body: { errors: getAt(body['settings'] as never, 'sessions.concurrency') === 11 ? ['sessions.concurrency must be a whole number from 1 to 10.'] : [] } });
    await opened();
    posts = [];

    type('sessions.concurrency', '1');
    type('sessions.concurrency', '11');
    await settle(CHECK_DELAY_MS - 1);
    expect(named('page-settings-check')).toHaveLength(0);
    expect(host.querySelector('.settings-nav-entry .settings-dirty')).not.toBeNull();
    expect(host.querySelector('.settings-status')?.textContent).toBe('Unsaved changes');
    await settle(1);
    expect(named('page-settings-check')).toHaveLength(1);
    expect(named('page-settings-check')[0]!.body['settings']).toEqual({ sessions: { installHooks: false, concurrency: 11 } });
    expect(host.querySelector('[data-path="sessions.concurrency"] .settings-field-error')?.textContent).toBe('sessions.concurrency must be a whole number from 1 to 10.');
    expect(host.querySelector('.settings-nav-entry .settings-errors')).not.toBeNull();
    expect(host.querySelector('.settings-status')?.textContent).toBe('Unsaved changes · 1 error');

    button('Save').click();
    await settle();
    expect(named('page-settings-save')).toHaveLength(0);
    expect(texts('.settings-bar .settings-error')).toEqual(['sessions.concurrency must be a whole number from 1 to 10.']);

    // The next edit drops the bar's errors.
    type('sessions.concurrency', '3');
    expect(host.querySelectorAll('.settings-bar .settings-error')).toHaveLength(0);
  });

  it("shows the check's warnings for retired settings in the bar, without counting them as errors or blocking a save", async () => {
    const retired = 'dock.openIn is no longer used and can be removed.';

    answers['page-settings-check'] = (body) => ({ status: 200, body: { errors: [], warnings: getAt(body['settings'] as never, 'dock') === undefined ? [] : [retired] } });
    answers['page-settings-read'] = { status: 200, body: config({ sessions: { installHooks: false }, dock: { openIn: 'web' } }) };
    await opened();

    expect(texts('.settings-bar .settings-warning')).toEqual([retired]);
    expect(host.querySelector('.settings-status')?.textContent).toBe('');
    // Nothing to save, so the bar has no buttons.
    expect(host.querySelector('.settings-bar-buttons')).toBeNull();

    type('sessions.concurrency', '3');
    await settle(CHECK_DELAY_MS);
    expect(texts('.settings-bar .settings-warning')).toEqual([retired]);
    expect(button('Save').disabled).toBe(false);
  });

  it('edits remote access on Devices: the Tailscale switch and, under Advanced, the allowed hosts and logins, one per line, each error on its list', async () => {
    answers['page-settings-check'] = (body) => ({ status: 200, body: { errors: (getAt(body['settings'] as never, 'web.remoteHosts') as string[] | undefined)?.includes('https://pc') === true ? ['web.remoteHosts must be a list of host names such as pc.tailnet.ts.net, without a port.'] : [] } });
    await opened();
    await go('devices');
    host.querySelector<HTMLButtonElement>('.settings-toggle')!.click();
    await settle();

    expect(field<HTMLInputElement>('web.tailscale').checked).toBe(false);
    expect(field<HTMLTextAreaElement>('web.remoteHosts').value).toBe('');
    field<HTMLInputElement>('web.tailscale').click();
    type('web.remoteHosts', 'pc.tail.ts.net\nhttps://pc');
    type('web.remoteLogins', ' Alex@Example.com \n\n');
    await settle(CHECK_DELAY_MS);
    expect(named('page-settings-check').at(-1)!.body['settings']).toEqual({ sessions: { installHooks: false }, web: { tailscale: true, remoteHosts: ['pc.tail.ts.net', 'https://pc'], remoteLogins: ['Alex@Example.com'] } });
    expect(host.querySelector('[data-path="web.remoteHosts"] .settings-field-error')?.textContent).toBe('web.remoteHosts must be a list of host names such as pc.tailnet.ts.net, without a port.');

    // Emptying a list removes its key.
    type('web.remoteHosts', '');
    await settle(CHECK_DELAY_MS);
    expect(named('page-settings-check').at(-1)!.body['settings']).toEqual({ sessions: { installHooks: false }, web: { tailscale: true, remoteLogins: ['Alex@Example.com'] } });
  });

  it('lists the paired devices on Devices once it shows, signs one out, and pairs a device with a QR code and code, showing a refusal', async () => {
    const now = Date.now();
    const phone = { id: '0123abcd', label: 'Android · Chrome', host: 'pc.tail.ts.net', login: 'alex@example.com', createdAt: now, usedAt: now, current: false };
    const own = { id: '89abcdef', label: 'Windows · Edge', host: null, login: null, createdAt: now, usedAt: now, current: true };

    answers['page-devices'] = { status: 200, body: { devices: [phone, own] } };
    answers['page-pair'] = { status: 409, body: { error: 'Pairing a device needs remote access.' } };
    const { pane } = await opened();

    // The list is read when Devices first shows, not when Settings opens.
    expect(named('page-devices')).toHaveLength(0);
    await go('devices');
    expect(named('page-devices')).toHaveLength(1);
    expect(texts('.settings-devices .device-name')).toEqual(['Android · Chrome', 'Windows · Edge (this browser)']);
    expect(texts('.settings-devices .device-detail').map((text) => text?.split(' · ')[0])).toEqual(['pc.tail.ts.net as alex@example.com', 'This computer']);
    // The list is its own section, before Remote access.
    expect(host.querySelector('.settings-devices')?.closest('.settings-section')?.querySelector('.settings-section-heading')?.textContent).toBe('Paired devices');

    // Voice is allowed only on a paired device, never this computer's sign-in, and the list then says so.
    expect([...host.querySelectorAll('[data-key="device-89abcdef"] button')].map((one) => one.textContent)).toEqual(['Sign out']);
    answers['page-device-voice'] = { status: 200, body: { voice: true } };
    answers['page-devices'] = { status: 200, body: { devices: [{ ...phone, voice: true }, own] } };
    buttonIn('[data-key="device-0123abcd"]', 'Allow voice').click();
    await settle();
    expect(named('page-device-voice').map((one) => one.body)).toEqual([{ id: '0123abcd', allow: true }]);
    expect(texts('.settings-devices .device-detail')[0]).toMatch(/ · voice allowed$/);
    answers['page-device-voice'] = { status: 404, body: { error: 'No paired device has the ID 0123abcd.' } };
    buttonIn('[data-key="device-0123abcd"]', 'Forbid voice').click();
    await settle();
    expect(named('page-device-voice').at(-1)!.body).toEqual({ id: '0123abcd', allow: false });
    expect(host.querySelector('.settings-devices .settings-error')?.textContent).toBe('No paired device has the ID 0123abcd.');

    // Sign out posts the device's ID and lists the devices again.
    answers['page-device-revoke'] = { status: 200, body: { revoked: 1 } };
    answers['page-devices'] = { status: 200, body: { devices: [own] } };
    buttonIn('[data-key="device-0123abcd"]', 'Sign out').click();
    await settle();
    expect(named('page-device-revoke').map((one) => one.body)).toEqual([{ id: '0123abcd' }]);
    expect(texts('.settings-devices .device-name')).toEqual(['Windows · Edge (this browser)']);

    // A refused pairing shows why, with no code.
    button('Pair a device…').click();
    await settle();
    expect(host.querySelector('.settings-devices .settings-error')?.textContent).toBe('Pairing a device needs remote access.');
    expect(host.querySelector('.settings-devices .pair')).toBeNull();

    answers['page-pair'] = { status: 200, body: { url: 'https://pc.tail.ts.net/page?t=' + 'a'.repeat(64), code: 'ABCD-EFGH', host: 'pc.tail.ts.net', expiresAt: now + 5 * 60_000 } };
    button('Pair a device…').click();
    await settle();
    expect(host.querySelector('.settings-devices .settings-error')).toBeNull();
    expect(host.querySelector('.settings-devices .pair-qr')).not.toBeNull();
    expect(host.querySelector('.settings-devices .pair-code')?.textContent).toBe('ABCD-EFGH');
    expect(host.querySelector('.settings-devices .pair strong')?.textContent).toBe('https://pc.tail.ts.net/');
    expect(button('New code')).toBeDefined();
    // Pairing changes nothing in settings.json.
    expect(host.querySelector('.settings-bar')).toBeNull();

    // Closing drops the code; opening Devices again lists the devices again.
    pane.requestClose();
    pane.open();
    await settle();
    expect(named('page-devices')).toHaveLength(6);
    await go('devices');
    expect(named('page-devices')).toHaveLength(7);
    expect(host.querySelector('.settings-devices .pair')).toBeNull();
  });

  it('keeps what was typed in a field while the draft holds its reading, and keeps a key the page has no field for', async () => {
    answers['page-settings-read'] = { status: 200, body: config({ sessions: { installHooks: false }, playbooks: { 'dev:x': { description: 'X', template: 'Do' } } }) };
    await opened();

    type('sessions.concurrency', '3 ');
    await settle(CHECK_DELAY_MS);
    expect(field<HTMLInputElement>('sessions.concurrency').value).toBe('3 ');
    expect(named('page-settings-check').at(-1)!.body['settings']).toEqual({ sessions: { installHooks: false, concurrency: 3 }, playbooks: { 'dev:x': { description: 'X', template: 'Do' } } });

    // Emptying a field removes its key, so the default applies.
    type('sessions.concurrency', '');
    await settle(CHECK_DELAY_MS);
    expect(named('page-settings-check').at(-1)!.body['settings']).toEqual({ sessions: { installHooks: false }, playbooks: { 'dev:x': { description: 'X', template: 'Do' } } });
    expect(host.querySelector('.settings-bar')).toBeNull();
  });

  it('saves the whole draft at the version it started from, reads the file again and closes; Ctrl+S saves and stays open', async () => {
    const { pane, closed } = await opened();

    answers['page-settings-save'] = (body) => {
      answers['page-settings-read'] = { status: 200, body: config(body['value'], { settings: { path: 'C:/home/.switchboard/settings.json', version: 'v2', value: body['value'], error: null } }) };
      return { status: 200, body: { saved: true, version: 'v2' } };
    };
    await go('advanced');
    field<HTMLInputElement>('sessions.codeMode').click();
    await settle();
    host.querySelector('.settings')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await settle();
    expect(named('page-settings-save')).toEqual([{ name: 'page-settings-save', body: { value: { sessions: { installHooks: false, codeMode: true } }, version: 'v1', configDir: 'C:/home/.switchboard' } }]);
    expect(pane.isOpen()).toBe(true);
    expect(host.querySelector('.settings-status')?.textContent).toBe('Saved');

    await go('display');
    field<HTMLSelectElement>('alerts.surface').value = 'system';
    field<HTMLSelectElement>('alerts.surface').dispatchEvent(new Event('change', { bubbles: true }));
    expect(host.querySelector('.settings-nav-entry.current .settings-dirty')).not.toBeNull();
    button('Save').click();
    await settle();
    expect(named('page-settings-save').at(-1)!.body).toMatchObject({ value: { sessions: { installHooks: false, codeMode: true }, alerts: { surface: 'system' } }, version: 'v2' });
    expect(pane.isOpen()).toBe(false);
    expect(host.innerHTML).toBe('');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('shows a refused save in the bar and keeps the draft, and says why Save is off when the file changed on disk', async () => {
    const { pane } = await opened();

    answers['page-settings-save'] = { status: 409, body: { errors: ['settings.json changed on disk after the editor read it. Discard your changes and open Settings again to load it.'] } };
    await go('triage');
    type('triage.model', 'haiku');
    button('Save').click();
    await settle();
    expect(pane.isOpen()).toBe(true);
    expect(texts('.settings-bar .settings-error')).toEqual(['settings.json changed on disk after the editor read it. Discard your changes and open Settings again to load it.']);
    expect(pane.state()?.draft).toEqual({ sessions: { installHooks: false }, triage: { model: 'haiku' } });

    // The page reads the file again when it comes back into view; another version under the draft turns Save off.
    answers['page-settings-read'] = { status: 200, body: config({ sessions: { installHooks: true } }, { settings: { path: 'p', version: 'v9', value: { sessions: { installHooks: true } }, error: null } }) };
    await pane.reload();
    await settle();
    expect(host.querySelector('.settings-warning')?.textContent).toBe('settings.json changed on disk, so your changes cannot be saved. Discard them and open Settings again to load it.');
    expect(button('Save').disabled).toBe(true);
    expect(button('Discard').disabled).toBe(false);
  });

  it("reads settings.json again after a refused save when the config event came while the save ran", async () => {
    const pane = (await opened()).pane;
    let release: (answer: Answer) => void = () => {};

    answers['page-settings-save'] = () => new Promise<Answer>((resolve) => (release = resolve)) as never;
    type('sessions.model', 'opus');
    button('Save').click();
    await settle(CHECK_DELAY_MS);
    expect(named('page-settings-save')).toHaveLength(1);

    const reads = named('page-settings-read').length;

    answers['page-settings-read'] = { status: 200, body: config({ sessions: { installHooks: true } }, { settings: { path: 'p', version: 'v7', value: { sessions: { installHooks: true } }, error: null } }) };
    await pane.reload();
    expect(named('page-settings-read')).toHaveLength(reads);
    release({ status: 409, body: { errors: ['settings.json changed on disk after the editor read it. Discard your changes and open Settings again to load it.'] } });
    await settle();
    expect(named('page-settings-read')).toHaveLength(reads + 1);
    expect(host.querySelector('.settings-warning')?.textContent).toBe('settings.json changed on disk, so your changes cannot be saved. Discard them and open Settings again to load it.');
    expect(button('Save').disabled).toBe(true);
  });

  it('asks before closing over unsaved changes: Keep editing stays, Discard closes without saving, and Escape asks too', async () => {
    const { pane } = await opened();

    type('sessions.model', 'opus');
    host.querySelector<HTMLButtonElement>('.settings-close')!.click();
    await settle();
    expect(host.querySelector('.settings-ask .sheet-title')?.textContent).toBe('Save changes to settings?');
    button('Keep editing').click();
    await settle();
    expect(host.querySelector('.settings-ask')).toBeNull();
    expect(pane.isOpen()).toBe(true);

    host.querySelector('.settings')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(host.querySelector('.settings-ask')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('.settings-ask .sheet-button.secondary')!.click();
    await settle();
    expect(pane.isOpen()).toBe(false);
    expect(named('page-settings-save')).toHaveLength(0);

    // Opened again, the file shows without the dropped draft; with no changes, Close closes at once.
    pane.open();
    await settle();
    expect(field<HTMLInputElement>('sessions.model').value).toBe('');
    host.querySelector<HTMLButtonElement>('.settings-close')!.click();
    expect(pane.isOpen()).toBe(false);
  });

  it('closes on a press on the dimmed backdrop as Close does, asking first over unsaved changes, and not on a press inside the dialog', async () => {
    const { pane } = await opened();
    const backdrop = host.querySelector<HTMLElement>('.settings-backdrop')!;

    expect(backdrop.querySelector('.settings[role="dialog"]')).not.toBeNull();
    host.querySelector<HTMLElement>('.settings-page')!.click();
    expect(pane.isOpen()).toBe(true);

    type('sessions.model', 'opus');
    host.querySelector<HTMLElement>('.settings-backdrop')!.click();
    await settle();
    expect(host.querySelector('.settings-ask .sheet-title')?.textContent).toBe('Save changes to settings?');
    // The editor behind the question takes no focus until it closes.
    expect(host.querySelector('.settings > .settings-body')?.hasAttribute('inert')).toBe(true);
    expect(host.querySelector('.settings > .settings-bar')?.hasAttribute('inert')).toBe(true);
    button('Keep editing').click();
    await settle();
    expect(pane.isOpen()).toBe(true);
    expect(host.querySelector('.settings > .settings-body')?.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(host.querySelector('.settings-close'));

    button('Discard').click();
    await settle();
    pane.open();
    await settle();
    host.querySelector<HTMLElement>('.settings-backdrop')!.click();
    expect(pane.isOpen()).toBe(false);
  });

  it('Discard drops every unsaved change and closes', async () => {
    const { pane } = await opened();

    type('sessions.model', 'opus');
    button('Discard').click();
    await settle();
    expect(pane.isOpen()).toBe(false);
    expect(named('page-settings-save')).toHaveLength(0);
  });

  it('shows an error that names no field at the top of every page, opens Advanced for a new error there, and says when settings.json cannot be read', async () => {
    answers['page-settings-check'] = { status: 200, body: { errors: ['Unknown key: extra.', 'triage.timeoutSeconds must be a whole number from 10 to 3600.', 'sessions.nodePath must not contain spaces.'] } };
    await opened();

    expect(texts('.settings-page > .settings-error')).toEqual(['Unknown key: extra. Fix it in settings.json: C:/home/.switchboard/settings.json']);
    // Each field's error marks its own page: Triage and Advanced, not Sessions, though nodePath sits in the sessions object.
    expect(texts('.settings-nav-entry:has(.settings-errors) .settings-nav-label')).toEqual(['Triage', 'Advanced']);
    await go('triage');
    expect(texts('.settings-page > .settings-error')).toEqual(['Unknown key: extra. Fix it in settings.json: C:/home/.switchboard/settings.json']);
    expect(host.querySelector('.settings-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('[data-path="triage.timeoutSeconds"] .settings-field-error')?.textContent).toBe('triage.timeoutSeconds must be a whole number from 10 to 3600.');
    // The operator can close it again.
    host.querySelector<HTMLButtonElement>('.settings-toggle')!.click();
    await settle();
    expect(host.querySelector('[data-path="triage.timeoutSeconds"]')).toBeNull();
    await go('advanced');
    expect(host.querySelector('[data-path="sessions.nodePath"] .settings-field-error')?.textContent).toBe('sessions.nodePath must not contain spaces.');

    answers['page-settings-read'] = { status: 200, body: config(undefined, { settings: { path: 'C:/s.json', version: null, value: undefined, error: 'Unexpected token } in JSON at position 4' } }) };
    answers['page-settings-check'] = { status: 200, body: { errors: [] } };
    host = document.createElement('div');
    document.body.replaceChildren(host);

    const other = start();

    other.pane.open();
    await settle();
    // settings.json's path shows with its error, since no page shows it then.
    expect(texts('.settings-page .settings-error')).toEqual(['C:/s.json: Unexpected token } in JSON at position 4']);
    expect(host.querySelector('.settings-page .settings-message')?.textContent).toBe('Fix the file in an editor; the page reads it again when it changes.');
    expect(host.querySelector('.settings-status')?.textContent).toBe('settings.json cannot be read');
  });

  it('says why when the hub does not answer, and discards the draft with a notice when the config folder changes', async () => {
    answers['page-settings-read'] = { status: 0, body: { error: 'Switchboard did not answer: offline' } };
    const { pane } = await opened();

    expect(host.querySelector('.settings-message')?.textContent).toBe('Switchboard did not answer: offline');

    answers['page-settings-read'] = { status: 200, body: config({}) };
    await pane.reload();
    type('sessions.model', 'opus');
    answers['page-settings-read'] = { status: 200, body: config({}, { configDir: 'D:/other' }) };
    await pane.reload();
    await settle();
    expect(host.querySelector('.settings-notice')?.textContent).toBe('The config folder changed to D:/other. Unsaved changes were discarded.');
    expect(pane.state()?.draft).toBeNull();
  });

  it("leaves a playbook's errors off General, shows a null value as empty, and shows a failed read in the navigation for a phone", async () => {
    answers['page-settings-read'] = { status: 200, body: config({ sessions: { installHooks: false, model: null }, playbooks: { 'dev:x': { description: 'X', template: '{{nope}}' } } }) };
    answers['page-settings-check'] = { status: 200, body: { errors: ['playbooks.dev:x: Unknown template variable: nope.'] } };
    await opened();

    expect(host.querySelectorAll('.settings-page .settings-error')).toHaveLength(0);
    expect(host.querySelector('.settings-nav-entry.current .settings-errors')).toBeNull();
    expect(host.querySelector('.settings-status')?.textContent).toBe('1 error');
    expect(field<HTMLInputElement>('sessions.model').value).toBe('');

    host = document.createElement('div');
    document.body.replaceChildren(host);
    answers['page-settings-read'] = { status: 0, body: { error: 'Switchboard did not answer: offline' } };
    await opened();
    expect(host.querySelector('.settings-nav .settings-nav-message')?.textContent).toBe('Switchboard did not answer: offline');
  });

  it('on a phone shows the navigation first, drills into a group and a page, and goes back up one level at a time with Back', async () => {
    // A phone on its side: the phone's layout by its screen, though the window is wide.
    vi.stubGlobal('screen', { width: 390, height: 844 });
    window.innerWidth = 844;
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    answers['page-settings-read'] = { status: 200, body: config({ sessions: { installHooks: false }, playbooks: { 'dev:x': { description: 'X', template: 'Do' } } }) };
    await opened();

    const settingsBox = host.querySelector('.settings')!;
    const back = () => host.querySelector<HTMLButtonElement>('.settings-back')!.click();
    const go = async (key: string) => {
      host.querySelector<HTMLButtonElement>(`.settings-nav-entry[data-key="${key}"]`)!.click();
      await settle();
    };

    expect(settingsBox.getAttribute('data-drill')).toBe('nav');
    expect(settingsBox.getAttribute('data-depth')).toBe('0');
    await go('sessions');
    expect(settingsBox.getAttribute('data-drill')).toBe('page');
    expect(document.activeElement).toBe(host.querySelector('.settings-page-title h2'));
    back();
    await settle();
    expect(settingsBox.getAttribute('data-drill')).toBe('nav');
    expect(document.activeElement?.textContent).toContain('Sessions');

    // Playbooks drills into its own list, a namespace into its, which starts with the namespace's table.
    await go('playbooks');
    expect(settingsBox.getAttribute('data-depth')).toBe('1');
    expect(texts('.settings-nav-heading')).toEqual(['Playbooks']);
    expect(texts('.settings-nav-entry .settings-nav-label')).toEqual(['dev', '+ New playbook']);
    await go('namespace:dev');
    expect(texts('.settings-nav-heading')).toEqual(['dev']);
    expect(texts('.settings-nav-entry .settings-nav-label')).toEqual(['All dev playbooks', 'x']);
    await go('playbook:dev:x');
    expect(settingsBox.getAttribute('data-drill')).toBe('page');
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('dev:x');

    // Back goes up one level at a time: the namespace's list, Playbooks' list, then the categories with the focus on Playbooks.
    back();
    await settle();
    expect(texts('.settings-nav-heading')).toEqual(['dev']);
    expect(host.querySelector('.settings-nav-entry.current')?.getAttribute('data-key')).toBe('playbook:dev:x');
    back();
    await settle();
    expect(texts('.settings-nav-heading')).toEqual(['Playbooks']);
    expect(document.activeElement?.getAttribute('data-key')).toBe('namespace:dev');
    back();
    await settle();
    expect(settingsBox.getAttribute('data-depth')).toBe('0');
    expect(texts('.settings-nav-heading')).toEqual(['Work', 'App', 'Voice']);
    expect(document.activeElement?.getAttribute('data-key')).toBe('playbooks');

    // An Add entry's new page takes the focus from the hidden navigation.
    await go('sources');
    await go('add-source:github');
    expect(document.activeElement).toBe(host.querySelector('.settings-page-title h2'));
    expect(document.activeElement?.textContent).toBe('GitHub');
  });

  it("shows a field's help under its label, read with its control, and no help where it has none", async () => {
    await opened();

    const help = host.querySelector('[data-path="sessions.concurrency"] .settings-help')!;

    expect(help.textContent).toBe('Sessions that run at once, 1 to 10. A start with no free slot waits as queued.');
    expect(help.closest('.settings-caption')?.querySelector('label')?.textContent).toBe('Concurrency');
    expect(field<HTMLInputElement>('sessions.concurrency').getAttribute('aria-describedby')).toBe(help.id);
    await go('triage');
    host.querySelector<HTMLButtonElement>('.settings-toggle')!.click();
    await settle();
    expect(host.querySelector('[data-path="triage.timeoutSeconds"] .settings-help')).toBeNull();
    expect(field<HTMLInputElement>('triage.timeoutSeconds').hasAttribute('aria-describedby')).toBe(false);
    // An on/off setting is a switch on its row's right.
    await go('advanced');
    expect(field<HTMLInputElement>('sessions.codeMode').getAttribute('role')).toBe('switch');
    expect(field<HTMLInputElement>('sessions.codeMode').closest('.settings-input')?.previousElementSibling?.classList.contains('settings-caption')).toBe(true);
  });
});

describe('Settings sources (architecture.md § Web page)', () => {
  let host: HTMLElement;
  let posts: Array<{ name: string; body: Record<string, unknown> }>;
  let answers: Record<string, Answer | ((body: Record<string, unknown>) => Answer)>;
  const file = {
    sessions: { installHooks: false },
    sources: { github: { repo: 'o/r', logins: ['me'], requireAssignee: false }, personal: { kind: 'github', repo: 'me/p' } },
    playbooks: { 'dev:triage': { description: 'T', kind: 'triage', template: 'x' }, 'dev:build': { description: 'B', template: 'y' } },
  };

  beforeEach(() => {
    // A desktop's width, whose navigation opens a group under its entry; the phone's drill-down has tests of its own.
    window.innerWidth = 1280;
    vi.useFakeTimers();
    posts = [];
    answers = { 'page-settings-read': { status: 200, body: config(file, { enabled: { github: true } }) }, 'page-settings-check': { status: 200, body: { errors: [] } } };
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
  const settle = () => vi.advanceTimersByTimeAsync(0);

  it("lists the sources in file order under Sources, noting one that is off, then New <kind> source for each kind without one and New source", async () => {
    await open();

    const sources = host.querySelector<HTMLButtonElement>('.settings-nav-entry[data-key="sources"]')!;

    // Closed, Sources counts its sources, leaving out the Add entries.
    expect(sources.querySelector('.settings-nav-count')?.textContent).toBe('2');
    sources.click();
    await settle();
    expect(texts('.settings-nav-children[aria-label="Sources"] .settings-nav-label')).toEqual(['GitHub', 'personal (GitHub)', '+ New Zoho Desk source', '+ New Forum source', '+ New source']);
    expect(entry('GitHub').querySelector('.settings-nav-note')).toBeNull();
    expect(entry('personal (GitHub)').querySelector('.settings-nav-note')?.textContent).toBe('off');
  });

  it("draws a source page: its kind's Connection fields, the Work fields, and a collapsed Advanced with Kind first, and the triage playbooks to choose", async () => {
    await open();
    entry('GitHub').click();
    await settle();

    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('GitHub');
    expect(headings()).toEqual(['Connection', 'Work', 'Advanced']);
    expect(texts('.settings-section:not(.advanced) .settings-caption label')).toEqual(['Repository', 'Logins', 'Require assignee', 'Wait for blockers', 'Include closed issues', 'Project owner', 'Project number', 'Status field', 'Assigned statuses', 'Repo root', 'Namespace', 'Triage playbook', 'Setup prompt', 'Poll interval (seconds)']);
    expect(host.querySelector('.settings-toggle-summary')?.textContent).toBe('Kind, Roles file, Branch pattern, gh path, Page limit');
    host.querySelector<HTMLButtonElement>('.settings-toggle')!.click();
    await settle();
    expect([...control<HTMLSelectElement>('sources.github.kind').options].map((one) => one.textContent)).toEqual(['Same as the name (github)', 'GitHub', 'Zoho Desk', 'Forum']);
    expect([...control<HTMLSelectElement>('sources.github.triagePlaybook').options].map((one) => one.value)).toEqual(['', 'dev:triage']);
    expect([...control<HTMLSelectElement>('sources.github.namespace').options].map((one) => one.value)).toEqual(['', 'dev']);
    expect(control<HTMLTextAreaElement>('sources.github.logins').value).toBe('me');
    expect(control<HTMLInputElement>('sources.github.requireAssignee').checked).toBe(false);
    expect(control<HTMLInputElement>('sources.github.waitForBlockers').checked).toBe(false);
    expect([...host.querySelectorAll('.settings-buttons button')].map((one) => one.textContent)).toEqual(['Remove source']);
  });

  it("drops the old plugin's keys when the kind changes and draws the new kind's fields", async () => {
    await open();
    entry('personal (GitHub)').click();
    await settle();
    host.querySelector<HTMLButtonElement>('.settings-toggle')!.click();
    await settle();

    const kind = control<HTMLSelectElement>('sources.personal.kind');

    kind.value = 'zoho';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('personal (Zoho Desk)');
    expect(headings()).toEqual(['Connection', 'Work', 'Advanced']);
    expect(host.querySelector('[data-path="sources.personal.orgId"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect((posts.at(-1)!.body['settings'] as { sources: unknown }).sources).toEqual({ github: file.sources.github, personal: { kind: 'zoho' } });
    expect(entry('personal (Zoho Desk)').querySelector('.settings-dirty')).not.toBeNull();
  });

  it('adds a source of a missing kind, removes a source to Sessions, and shows a source error on its field and its page', async () => {
    answers['page-settings-check'] = (body) => ({ status: 200, body: { errors: getAt(body['settings'] as never, 'sources.zoho') === undefined ? [] : ['sources.zoho.orgId is required.'] } });
    await open();

    entry('+ New Zoho Desk source').click();
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('Zoho Desk');
    expect(host.querySelector('[data-path="sources.zoho.orgId"] .settings-field-error')?.textContent).toBe('sources.zoho.orgId is required.');
    expect(entry('Zoho Desk').querySelector('.settings-errors')).not.toBeNull();
    expect(entry('Zoho Desk').querySelector('.settings-nav-note')?.textContent).toBe('off');
    expect(host.querySelector('.settings-page > .settings-error')).toBeNull();

    [...host.querySelectorAll<HTMLButtonElement>('.settings-buttons button')][0]!.click();
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('Sessions');
    expect(texts('.settings-nav-entry .settings-nav-label')).toContain('+ New Zoho Desk source');
    expect(host.querySelector('.settings-bar')).toBeNull();

    entry('GitHub').click();
    await settle();
    [...host.querySelectorAll<HTMLButtonElement>('.settings-buttons button')][0]!.click();
    await settle();
    expect(texts('.settings-nav-children[aria-label="Sources"] .settings-nav-label')).toEqual(['personal (GitHub)', '+ New GitHub source', '+ New Zoho Desk source', '+ New Forum source', '+ New source']);
    // Sources, closed, carries the unsaved mark of the source removed from it.
    host.querySelector<HTMLButtonElement>('.settings-nav-entry[data-key="sources"]')!.click();
    await settle();
    expect(host.querySelector('.settings-nav-entry[data-key="sources"] .settings-dirty')).not.toBeNull();
    expect(host.querySelector('.settings-status')?.textContent).toBe('Unsaved changes');
  });

  it('New source asks for a kind and a name, refuses an invalid or taken name on Create, and adds an entry of that kind', async () => {
    await open();
    entry('+ New source').click();
    await settle();

    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('New source');
    expect([...host.querySelectorAll<HTMLOptionElement>('#settings-new-kind option')].map((one) => one.value)).toEqual(['github', 'zoho', 'forum']);
    expect(host.querySelector('[data-path="new-name"] .settings-field-error')).toBeNull();

    const create = () => [...host.querySelectorAll<HTMLButtonElement>('.settings-buttons button')].find((one) => one.textContent === 'Create')!.click();
    const name = (text: string) => {
      const box = host.querySelector<HTMLInputElement>('#settings-new-name')!;

      box.value = text;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    };

    create();
    await settle();
    expect(host.querySelector('[data-path="new-name"] .settings-field-error')?.textContent).toBe('The name must be lowercase letters, digits and hyphens.');
    name('personal');
    expect(host.querySelector('[data-path="new-name"] .settings-field-error')?.textContent).toBe('A source named personal already exists.');
    name('adhoc');
    expect(host.querySelector('[data-path="new-name"] .settings-field-error')?.textContent).toBe("adhoc names Switchboard's own tickets; choose another name.");
    name('widgets-dashboard');
    expect(host.querySelector('.settings-bar')).toBeNull();

    const kind = host.querySelector<HTMLSelectElement>('#settings-new-kind')!;

    kind.value = 'forum';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    create();
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('widgets-dashboard (Forum)');
    expect((posts.at(-1)!.body['settings'] as { sources: Record<string, unknown> }).sources['widgets-dashboard']).toEqual({ kind: 'forum' });
  });
});
