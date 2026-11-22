import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_DELAY_MS, settings } from '../src/settings.js';
import { EditorState, fieldOfError, getAt, parseConfig, readField, setAt, withCurrent } from '../src/settingsModel.js';

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

describe('the Settings model (settingsModel.ts), as the dock\'s', () => {
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

  it('reads a field\'s input as the dock does: empty removes the key, and text that is no number is kept for the check to name', () => {
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
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.trim() === label)!;
  const buttonIn = (selector: string, label: string) => [...host.querySelectorAll<HTMLButtonElement>(`${selector} button`)].find((one) => one.textContent?.trim() === label)!;
  const named = (name: string) => posts.filter((one) => one.name === name);

  it('reads settings.json and draws General as the dock does: its sections in order, the file, Saved, and Advanced collapsed', async () => {
    await opened();

    expect(named('page-settings-read')).toHaveLength(1);
    expect(texts('.settings-nav-entry .settings-nav-label').slice(0, 5)).toEqual(['General', '+ New GitHub source', '+ New Zoho Desk source', '+ New Forum source', '+ New source']);
    expect(host.querySelector('.settings-nav-entry.current')?.textContent).toContain('General');
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('General');
    expect(host.querySelector('.settings-file')?.textContent).toBe('C:/home/.switchboard/settings.json');
    expect(texts('.settings-section-heading')).toEqual(['Sessions', 'Claude sessions', 'Codex sessions', 'Triage', 'Dock', 'Alerts', 'Web page', 'Remote access', 'Advanced']);
    expect(texts('.settings-section:not(.advanced) .settings-caption label')).toEqual(['Default agent', 'Concurrency', 'Code Mode (experimental)', 'Friction debriefs', 'Model', 'Permission mode', 'Model', 'Permission mode', 'Concurrency', 'Model', 'Timeout (seconds)', 'Rows open in', 'Row click opens', 'Terminal for "Open in terminal"', 'Needs-you alerts from', 'Chrome pane (experimental)', 'Tailscale', 'Allowed hosts', 'Allowed logins']);
    expect(host.querySelector('[data-path="sessions.installHooks"]')).toBeNull();
    expect(host.querySelector('.settings-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.settings-status')?.textContent).toBe('Saved');
    expect(button('Save').disabled).toBe(true);
    expect(button('Discard').disabled).toBe(true);
    // A field shows its default as its placeholder, and a select its default choice.
    expect(field<HTMLInputElement>('sessions.concurrency').placeholder).toBe('2');
    expect(field<HTMLSelectElement>('sessions.provider').value).toBe('claude');
    expect([...field<HTMLSelectElement>('sessions.provider').options].map((option) => option.textContent)).toEqual(['Claude', 'Codex']);
    expect(field<HTMLSelectElement>('sessions.codex.permissionMode').value).toBe('bypassPermissions');
    expect(field<HTMLSelectElement>('dock.openIn').value).toBe('vscode');
    expect([...field<HTMLSelectElement>('alerts.surface').options].map((option) => option.textContent)).toEqual(['Web app when open', 'Web page when open', 'Dock']);

    // Advanced opens to show the executable paths, and Install hooks shows the file's false over its default true.
    host.querySelector<HTMLButtonElement>('.settings-toggle')!.click();
    await settle();
    expect(texts('.settings-section.advanced .settings-caption label')).toEqual(['Install hooks', 'Claude Code path', 'Codex path', 'Node.js path']);
    expect(field<HTMLInputElement>('sessions.installHooks').checked).toBe(false);
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

  it('edits remote access under General: the Tailscale switch and the allowed hosts and logins, one per line, each error on its list', async () => {
    answers['page-settings-check'] = (body) => ({ status: 200, body: { errors: (getAt(body['settings'] as never, 'web.remoteHosts') as string[] | undefined)?.includes('https://pc') === true ? ['web.remoteHosts must be a list of host names such as pc.tailnet.ts.net, without a port.'] : [] } });
    await opened();

    expect(field<HTMLInputElement>('web.tailscale').checked).toBe(false);
    expect(field<HTMLTextAreaElement>('web.remoteHosts').value).toBe('');
    field<HTMLInputElement>('web.tailscale').click();
    type('web.remoteHosts', 'pc.tail.ts.net\nhttps://pc');
    type('web.remoteLogins', ' alex@example.com \n\n');
    await settle(CHECK_DELAY_MS);
    expect(named('page-settings-check').at(-1)!.body['settings']).toEqual({ sessions: { installHooks: false }, web: { tailscale: true, remoteHosts: ['pc.tail.ts.net', 'https://pc'], remoteLogins: ['alex@example.com'] } });
    expect(host.querySelector('[data-path="web.remoteHosts"] .settings-field-error')?.textContent).toBe('web.remoteHosts must be a list of host names such as pc.tailnet.ts.net, without a port.');

    // Emptying a list removes its key.
    type('web.remoteHosts', '');
    await settle(CHECK_DELAY_MS);
    expect(named('page-settings-check').at(-1)!.body['settings']).toEqual({ sessions: { installHooks: false }, web: { tailscale: true, remoteLogins: ['alex@example.com'] } });
  });

  it('lists the paired devices under Remote access, signs one out, and pairs a device with a QR code and code, showing a refusal', async () => {
    const now = Date.now();
    const phone = { id: '0123abcd', label: 'Android · Chrome', host: 'pc.tail.ts.net', login: 'alex@example.com', createdAt: now, usedAt: now, current: false };
    const own = { id: '89abcdef', label: 'Windows · Edge', host: null, login: null, createdAt: now, usedAt: now, current: true };

    answers['page-devices'] = { status: 200, body: { devices: [phone, own] } };
    answers['page-pair'] = { status: 409, body: { error: 'Pairing a device needs remote access.' } };
    const { pane } = await opened();

    expect(named('page-devices')).toHaveLength(1);
    expect(texts('.settings-devices .device-name')).toEqual(['Android · Chrome', 'Windows · Edge (this browser)']);
    expect(texts('.settings-devices .device-detail').map((text) => text?.split(' · ')[0])).toEqual(['pc.tail.ts.net as alex@example.com', 'This computer']);
    // The list sits in the Remote access section, after its fields.
    expect(host.querySelector('.settings-devices')?.closest('.settings-section')?.querySelector('.settings-section-heading')?.textContent).toBe('Remote access');

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
    expect(host.querySelector('.settings-status')?.textContent).toBe('Saved');

    // Closing drops the code; opening again lists the devices again.
    pane.requestClose();
    pane.open();
    await settle();
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
    expect(host.querySelector('.settings-status')?.textContent).toBe('Saved');
  });

  it('saves the whole draft at the version it started from, reads the file again and closes; Ctrl+S saves and stays open', async () => {
    const { pane, closed } = await opened();

    answers['page-settings-save'] = (body) => {
      answers['page-settings-read'] = { status: 200, body: config(body['value'], { settings: { path: 'C:/home/.switchboard/settings.json', version: 'v2', value: body['value'], error: null } }) };
      return { status: 200, body: { saved: true, version: 'v2' } };
    };
    field<HTMLInputElement>('sessions.codeMode').click();
    await settle();
    host.querySelector('.settings')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await settle();
    expect(named('page-settings-save')).toEqual([{ name: 'page-settings-save', body: { value: { sessions: { installHooks: false, codeMode: true } }, version: 'v1', configDir: 'C:/home/.switchboard' } }]);
    expect(pane.isOpen()).toBe(true);
    expect(host.querySelector('.settings-status')?.textContent).toBe('Saved');

    field<HTMLSelectElement>('dock.openVSCode').value = 'review';
    field<HTMLSelectElement>('dock.openVSCode').dispatchEvent(new Event('change', { bubbles: true }));
    field<HTMLSelectElement>('alerts.surface').value = 'dock';
    field<HTMLSelectElement>('alerts.surface').dispatchEvent(new Event('change', { bubbles: true }));
    expect(host.querySelector('.settings-nav-entry.current .settings-dirty')).not.toBeNull();
    button('Save').click();
    await settle();
    expect(named('page-settings-save').at(-1)!.body).toMatchObject({ value: { sessions: { installHooks: false, codeMode: true }, dock: { openVSCode: 'review' }, alerts: { surface: 'dock' } }, version: 'v2' });
    expect(pane.isOpen()).toBe(false);
    expect(host.innerHTML).toBe('');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('shows a refused save in the bar and keeps the draft, and says why Save is off when the file changed on disk', async () => {
    const { pane } = await opened();

    answers['page-settings-save'] = { status: 409, body: { errors: ['settings.json changed on disk after the editor read it. Discard your changes and open Settings again to load it.'] } };
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

  it('Discard drops every unsaved change and closes, as the dock\'s', async () => {
    const { pane } = await opened();

    type('sessions.model', 'opus');
    button('Discard').click();
    await settle();
    expect(pane.isOpen()).toBe(false);
    expect(named('page-settings-save')).toHaveLength(0);
  });

  it('shows an error that names no field at the top of the page, opens Advanced for a new error there, and says when settings.json cannot be read', async () => {
    answers['page-settings-check'] = { status: 200, body: { errors: ['Unknown key: extra.', 'sessions.nodePath must not contain spaces.'] } };
    await opened();

    expect(texts('.settings-page > .settings-error')).toEqual(['Unknown key: extra.']);
    expect(host.querySelector('.settings-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('[data-path="sessions.nodePath"] .settings-field-error')?.textContent).toBe('sessions.nodePath must not contain spaces.');
    // The operator can close it again.
    host.querySelector<HTMLButtonElement>('.settings-toggle')!.click();
    await settle();
    expect(host.querySelector('[data-path="sessions.nodePath"]')).toBeNull();

    answers['page-settings-read'] = { status: 200, body: config(undefined, { settings: { path: 'C:/s.json', version: null, value: undefined, error: 'Unexpected token } in JSON at position 4' } }) };
    answers['page-settings-check'] = { status: 200, body: { errors: [] } };
    host = document.createElement('div');
    document.body.replaceChildren(host);

    const other = start();

    other.pane.open();
    await settle();
    expect(texts('.settings-page .settings-error')).toEqual(['Unexpected token } in JSON at position 4']);
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
    expect(host.querySelector('.settings-status')?.textContent).toBe('Saved · 1 error');
    expect(field<HTMLInputElement>('sessions.model').value).toBe('');

    host = document.createElement('div');
    document.body.replaceChildren(host);
    answers['page-settings-read'] = { status: 0, body: { error: 'Switchboard did not answer: offline' } };
    await opened();
    expect(host.querySelector('.settings-nav .settings-nav-message')?.textContent).toBe('Switchboard did not answer: offline');
  });

  it('on a phone shows the navigation first, drills into a page and goes back with Back', async () => {
    await opened();

    expect(host.querySelector('.settings')?.getAttribute('data-drill')).toBe('nav');
    host.querySelector<HTMLButtonElement>('.settings-nav-entry')!.click();
    await settle();
    expect(host.querySelector('.settings')?.getAttribute('data-drill')).toBe('page');
    host.querySelector<HTMLButtonElement>('.settings-back')!.click();
    await settle();
    expect(host.querySelector('.settings')?.getAttribute('data-drill')).toBe('nav');
    expect(document.activeElement?.textContent).toContain('General');

    // At a phone's width the page's title takes the focus from the hidden navigation, also after an Add entry.
    const media = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);

    [...host.querySelectorAll<HTMLButtonElement>('.settings-nav-entry')].find((one) => one.textContent?.includes('New GitHub source'))!.click();
    await settle();
    expect(document.activeElement).toBe(host.querySelector('.settings-page-title h2'));
    expect(document.activeElement?.textContent).toBe('GitHub');
    media.mockRestore();
  });

  it('shows a field\'s help under it when its info icon is tapped, as well as in its tooltip', async () => {
    await opened();

    const info = host.querySelector<HTMLButtonElement>('[data-path="sessions.concurrency"] .settings-info')!;

    expect(info.title).toBe('Sessions that run at once, 1 to 10. A start with no free slot waits as queued.');
    info.click();
    await settle();
    expect(host.querySelector('[data-path="sessions.concurrency"] .settings-help')?.textContent).toBe('Sessions that run at once, 1 to 10. A start with no free slot waits as queued.');
    expect(host.querySelector('[data-path="triage.timeoutSeconds"] .settings-info')).toBeNull();
  });
});

describe('Settings sources (architecture.md § Settings window)', () => {
  let host: HTMLElement;
  let posts: Array<{ name: string; body: Record<string, unknown> }>;
  let answers: Record<string, Answer | ((body: Record<string, unknown>) => Answer)>;
  const file = {
    sessions: { installHooks: false },
    sources: { github: { repo: 'o/r', logins: ['me'], requireAssignee: false }, personal: { kind: 'github', repo: 'me/p' } },
    playbooks: { 'dev:triage': { description: 'T', kind: 'triage', template: 'x' }, 'dev:build': { description: 'B', template: 'y' } },
  };

  beforeEach(() => {
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
  const entry = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.settings-nav-entry')].find((one) => one.querySelector('.settings-nav-label')?.textContent === label)!;
  const control = <T extends HTMLElement>(path: string) => host.querySelector<T>(`[data-path="${path}"] input, [data-path="${path}"] select, [data-path="${path}"] textarea`)!;
  const settle = () => vi.advanceTimersByTimeAsync(0);

  it("lists the sources in file order under Sources, noting one that is off, then New <kind> source for each kind without one and New source", async () => {
    await open();

    expect(texts('.settings-nav-heading')[0]).toBe('Sources');
    expect(texts('.settings-nav-entry .settings-nav-label').slice(0, 6)).toEqual(['General', 'GitHub', 'personal (GitHub)', '+ New Zoho Desk source', '+ New Forum source', '+ New source']);
    expect(entry('GitHub').querySelector('.settings-nav-note')).toBeNull();
    expect(entry('personal (GitHub)').querySelector('.settings-nav-note')?.textContent).toBe('off');
  });

  it("draws a source page with the dock's fields: Kind, the common ones, its kind's own and a collapsed Advanced, and the triage playbooks to choose", async () => {
    await open();
    entry('GitHub').click();
    await settle();

    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('GitHub');
    expect(texts('.settings-section-heading')).toEqual(['Source', 'GitHub', 'Advanced']);
    expect(texts('.settings-section:not(.advanced) .settings-caption label')).toEqual(['Kind', 'Poll interval (seconds)', 'Repo root', 'Namespace', 'Triage playbook', 'Setup prompt', 'Repository', 'Logins', 'Require assignee', 'Wait for blockers', 'Include closed issues', 'Project owner', 'Project number', 'Status field', 'Assigned statuses']);
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

    const kind = control<HTMLSelectElement>('sources.personal.kind');

    kind.value = 'zoho';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('personal (Zoho Desk)');
    expect(texts('.settings-section-heading')).toEqual(['Source', 'Zoho Desk', 'Advanced']);
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect((posts.at(-1)!.body['settings'] as { sources: unknown }).sources).toEqual({ github: file.sources.github, personal: { kind: 'zoho' } });
    expect(entry('personal (Zoho Desk)').querySelector('.settings-dirty')).not.toBeNull();
  });

  it('adds a source of a missing kind, removes a source to General, and shows a source error on its field and its page', async () => {
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
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('General');
    expect(texts('.settings-nav-entry .settings-nav-label')).toContain('+ New Zoho Desk source');
    expect(host.querySelector('.settings-status')?.textContent).toBe('Saved');

    entry('GitHub').click();
    await settle();
    [...host.querySelectorAll<HTMLButtonElement>('.settings-buttons button')][0]!.click();
    await settle();
    expect(texts('.settings-nav-entry .settings-nav-label').slice(0, 6)).toEqual(['General', 'personal (GitHub)', '+ New GitHub source', '+ New Zoho Desk source', '+ New Forum source', '+ New source']);
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
    expect(host.querySelector('.settings-status')?.textContent).toBe('Saved');

    const kind = host.querySelector<HTMLSelectElement>('#settings-new-kind')!;

    kind.value = 'forum';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    create();
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(host.querySelector('.settings-page-title h2')?.textContent).toBe('widgets-dashboard (Forum)');
    expect((posts.at(-1)!.body['settings'] as { sources: Record<string, unknown> }).sources['widgets-dashboard']).toEqual({ kind: 'forum' });
  });
});
