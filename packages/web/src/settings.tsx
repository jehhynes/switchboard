// The web page's Settings (architecture.md § Web page, PRD R54): the dock's Settings window over the whole page, drawn with Preact, posting the
// hub's config routes as page commands. Its state, fields and pages are the dock's, in settingsModel.ts.
import type { VNode } from 'preact';
import { mount } from './island.js';
import { applyPlaybookCell, applyPlaybookField, bar, clone, COMMON_SOURCE_KEYS, EditorState, emptyNewPlaybook, getAt, nav, newPlaybookName, pageSections, pageView, parseConfig, playbookEntry, readField, readPlaybook, samePlaybook, setAt, sourceKind } from './settingsModel.js';
import type { Field, FieldView, Json, JsonObject, NavEntry, NewNameView, PageButton, PageView, PlaybookFields, PlaybookTable, SectionView } from './settingsModel.js';

type Answer = { status: number; body: Record<string, unknown> };

export interface SettingsDeps {
  /** Posts a page command with the page key, as the page's other commands do. */
  post(name: string, body: Record<string, unknown>): Promise<Answer>;
  /** Called once Settings closes, so the page can take the focus back. */
  closed?(): void;
}

/** Whether the page is as narrow as a phone's, where the navigation and the page each take the screen (settings.css). */
const phone = (): boolean => typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches;

/** The draft is checked this long after the last edit, as the dock's. */
export const CHECK_DELAY_MS = 250;

/** The question Settings asks: before closing over unsaved changes, or before deleting a playbook. */
type Ask = { kind: 'close' } | { kind: 'delete'; name: string; detail: string };

/** What Settings shows besides the editor's state: whether it is open, which half a phone shows, and what the operator opened. */
interface View {
  open: boolean;
  /** On a phone, the navigation list or the page it drilled into. */
  drill: 'nav' | 'page';
  /** Why settings.json could not be read, or null. */
  error: string | null;
  /** What a read discarded, or null. */
  notice: string | null;
  /** The Advanced sections the operator opened, by page and heading, so a redraw keeps them open. */
  opened: Set<string>;
  /** The fields whose help is shown, by path. */
  help: Set<string>;
  /** The fields that had errors at the last draw, so a new error opens its Advanced section once. */
  erred: Set<string>;
  /** The text typed in each field since the page was drawn, so a field shows what was typed, not the value read from it. */
  typing: Map<string, string>;
  ask: Ask | null;
}

export interface Settings {
  /** Opens Settings and reads settings.json. */
  open(): void;
  /** Closes Settings, asking first over unsaved changes. */
  requestClose(): void;
  isOpen(): boolean;
  /** The editor's state, for tests; null before the first read answers. */
  state(): EditorState | null;
  /** Reads settings.json again, as when the page comes back into view. */
  reload(): Promise<void>;
}

/** Settings drawn into `host`: the navigation, the page and the bar, as the dock's window, and a phone's list that drills into each page. */
export function settings(host: HTMLElement, deps: SettingsDeps): Settings {
  const view: View = { open: false, drill: 'nav', error: null, notice: null, opened: new Set(), help: new Set(), erred: new Set(), typing: new Map(), ask: null };
  let state: EditorState | null = null;
  let loads = 0;
  let seq = 0;
  let edits = 0;
  let checkedEdits = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<boolean> | null = null;

  const draw = (): void => {
    if (!view.open) {
      mount(host, null);
      return;
    }

    mount(host, renderSettings(state, view, handlers));
  };

  /** Draws a page anew: the fields show the values read, not what was typed into the page before. */
  const redraw = (): void => {
    view.typing.clear();
    draw();
  };

  const cancelCheck = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** Checks the whole draft, or the file when there is none; an answer to an older check is dropped. */
  const check = async (): Promise<void> => {
    const current = state;

    if (current === null) {
      return;
    }

    const covered = edits;
    const value = current.value;

    if (value === null) {
      current.errors = [];
      checkedEdits = covered;
      return;
    }

    const mine = ++seq;
    const answer = await deps.post('page-settings-check', { settings: clone(value) });

    if (mine !== seq || state !== current || answer.status !== 200 || !Array.isArray(answer.body['errors'])) {
      return;
    }

    current.errors = (answer.body['errors'] as unknown[]).map(String);
    checkedEdits = covered;
    draw();
  };

  const checkSoon = (): void => {
    cancelCheck();
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, CHECK_DELAY_MS);
  };

  /** Reads settings.json, as when Settings opens, Discard is pressed, or the page comes back into view. */
  const load = async (): Promise<void> => {
    const mine = ++loads;
    const answer = await deps.post('page-settings-read', {});

    // A later read already answered.
    if (mine !== loads) {
      return;
    }

    if (answer.status !== 200) {
      view.error = String(answer.body['error'] ?? 'Switchboard did not answer.');
      draw();
      return;
    }

    view.error = null;

    const config = parseConfig(answer.body);
    const shown = state?.signature();

    if (state === null) {
      state = new EditorState(config);
    } else if (state.config.configDir !== config.configDir) {
      // The draft and its version belong to the old folder, and a save could overwrite an identical file in the new one.
      view.notice = `The config folder changed to ${config.configDir}. Unsaved changes were discarded.`;
      state = new EditorState(config);
    } else {
      state.refresh(config);
    }

    // A read after the page's own save changes nothing on the page; drawing it anew would drop what is being typed.
    if (shown !== state.signature()) {
      redraw();
    } else {
      draw();
    }

    await check();
  };

  /** After a change to the draft: drops the bar's errors, draws the page, and checks the draft once the operator pauses. */
  const edited = (): void => {
    state!.barErrors = [];
    edits++;
    draw();
    checkSoon();
  };

  /** Drafts a playbook changed by `changeOf`; false when its entry cannot be read or nothing changed. */
  const setPlaybook = (name: string, changeOf: (playbook: PlaybookFields) => PlaybookFields): boolean => {
    const current = state;
    const value = current?.value ?? null;
    const playbook = current?.playbookValue(name) ?? null;

    if (current === null || value === null || playbook === null) {
      return false;
    }

    const next = changeOf(playbook);

    if (samePlaybook(next, playbook)) {
      return false;
    }

    let entry: JsonObject = playbookEntry(next);
    const file = current.fileEntry(name);
    const onDisk = readPlaybook(file).fields;

    // Undoing an edit restores the entry as the file holds it, so the playbook is no longer marked unsaved.
    if (onDisk !== null && JSON.stringify(playbookEntry(onDisk)) === JSON.stringify(entry)) {
      entry = clone(file as JsonObject);
    }

    current.setDraft(withPlaybook(value, name, entry));
    return true;
  };

  /** A checkbox in a namespace page's table, for one of its playbooks. */
  const editCell = (name: string, path: string, checked: boolean): void => {
    if (setPlaybook(name, (playbook) => applyPlaybookCell(playbook, path, checked))) {
      edited();
    }
  };

  /** A field's new input on the current page: its text, or a checkbox's checked state. */
  const edit = (field: Field, input: string, checked = false): void => {
    const current = state;
    const value = current?.value ?? null;

    if (current === null || value === null) {
      return;
    }

    if (current.page === 'new-playbook') {
      // Text typed on the New playbook page before Create is not a change to the file.
      current.newPlaybook = { ...current.newPlaybook, playbook: applyPlaybookField(current.newPlaybook.playbook, field.path, input, checked) };
      view.typing.set(field.path, input);
      draw();
      return;
    }

    if (current.page.startsWith('playbook:')) {
      if (setPlaybook(current.page.slice('playbook:'.length), (playbook) => applyPlaybookField(playbook, field.path, input, checked))) {
        view.typing.set(field.path, input);
        edited();
      }

      return;
    }

    if (pageSections(current, current.page).length === 0) {
      return;
    }

    let next = setAt(value, field.path, readField(field.kind, input, checked, field.listDefault !== undefined));
    const source = /^sources\.([^.]+)\.kind$/.exec(field.path)?.[1];

    // A source's new kind keeps only the common keys, because each plugin rejects another's keys, and draws the new kind's fields.
    if (source !== undefined && sourceKind(next, source) !== sourceKind(value, source)) {
      const entry = getAt(next, `sources.${source}`) as JsonObject;

      next = setAt(next, `sources.${source}`, Object.fromEntries(Object.entries(entry).filter(([key]) => COMMON_SOURCE_KEYS.includes(key))));
      view.typing.clear();
    } else {
      view.typing.set(field.path, input);
    }

    // A weekday and a day of the month are different values, so a new period starts without the old one's day; by hand takes no time.
    const schedule = /^(schedules\.[^.]+)\.every$/.exec(field.path)?.[1];

    if (schedule !== undefined) {
      next = setAt(next, `${schedule}.day`, undefined);

      if (input === '') {
        next = setAt(next, `${schedule}.at`, undefined);
      }

      view.typing.delete(`${schedule}.day`);
      view.typing.delete(`${schedule}.at`);
    }

    current.setDraft(next);
    edited();
  };

  /** Changes the draft from a page's button or an Add entry, and opens `page`. */
  const change = (next: JsonObject, page: string): void => {
    state!.setDraft(next);
    state!.page = page;
    view.drill = 'page';
    view.typing.clear();
    edited();

    // On a phone the navigation, such as New <kind> source that made the change, is hidden now, so the page's title takes the focus.
    if (phone()) {
      host.querySelector<HTMLElement>('.settings-page-title h2')?.focus();
    }
  };

  const addSource = (kind: string): void => {
    const value = state?.value ?? null;

    if (value !== null) {
      change(setAt(value, `sources.${kind}`, {}), `source:${kind}`);
    }
  };

  /** Create on a New page: refuses an invalid or taken name, showing why, and otherwise adds the entry to the draft and opens its page. */
  const create = (): void => {
    const current = state;
    const value = current?.value ?? null;

    if (current === null || value === null) {
      return;
    }

    if (current.page === 'new-source') {
      if (current.newSourceError !== null) {
        current.newSource = { ...current.newSource, touched: true };
        draw();
        return;
      }

      const name = current.newSource.name.trim();
      const kind = current.newSourceKind;

      current.newSource = { name: '', kind: '', touched: false };
      change(setAt(value, `sources.${name}`, kind === name ? {} : { kind }), `source:${name}`);
      return;
    }

    if (current.page === 'new-schedule') {
      if (current.newScheduleError !== null) {
        current.newSchedule = { ...current.newSchedule, touched: true };
        draw();
        return;
      }

      const name = current.newSchedule.name.trim();

      current.newSchedule = { name: '', touched: false };
      change(setAt(value, `schedules.${name}`, {}), `schedule:${name}`);
      return;
    }

    if (current.page === 'new-playbook') {
      if (current.newNameError !== null) {
        current.newPlaybook = { ...current.newPlaybook, touched: true };
        draw();
        return;
      }

      const name = newPlaybookName(current.newPlaybook);
      const entry = playbookEntry(current.newPlaybook.playbook);

      current.newPlaybook = emptyNewPlaybook();
      change(withPlaybook(value, name, entry), `playbook:${name}`);
    }
  };

  /** Delete on a playbook's page: asks first, naming how many open work items use it, read from the hub now, since they change. */
  const askDelete = async (): Promise<void> => {
    const current = state;

    if (current === null || !current.page.startsWith('playbook:')) {
      return;
    }

    const name = current.page.slice('playbook:'.length);

    if (!current.hasPlaybook(name)) {
      return;
    }

    const answer = await deps.post('page-settings-read', {});
    const inUse = answer.status === 200 ? parseConfig(answer.body).inUse : current.config.inUse;
    const count = inUse[name] ?? 0;
    const removed = 'Save removes it from settings.json.';

    if (state !== current || current.page !== `playbook:${name}`) {
      return;
    }

    view.ask = { kind: 'delete', name, detail: count === 0 ? removed : `${count} open work ${count === 1 ? 'item uses' : 'items use'} it. ${removed}` };
    draw();
    host.querySelector<HTMLElement>('.settings-ask .sheet-button.secondary')?.focus();
  };

  /** The New page's name or kind as typed. */
  const editName = (part: 'name' | 'kind' | 'namespace', text: string): void => {
    if (state === null) {
      return;
    }

    if (state.page === 'new-source') {
      state.newSource = { ...state.newSource, [part]: text };
    } else if (state.page === 'new-schedule') {
      state.newSchedule = { ...state.newSchedule, name: text };
    } else if (state.page === 'new-playbook') {
      state.newPlaybook = { ...state.newPlaybook, [part === 'namespace' ? 'namespace' : 'name']: text };
    }

    draw();
  };

  /** A page's header button: Create, or the remove of the page's own entry, which only changes the draft. */
  const button = (pressed: PageButton): void => {
    const value = state?.value ?? null;

    if (value === null) {
      return;
    }

    switch (pressed.command) {
      case 'create':
        create();
        break;
      case 'delete':
        void askDelete();
        break;
      case 'remove-schedule':
        // Its work items stay, and Discard restores it.
        change(setAt(value, `schedules.${pressed.argument!}`, undefined), 'general');
        break;
      case 'remove-source':
        // Its work items stay, and Discard restores it.
        change(setAt(value, `sources.${pressed.argument!}`, undefined), 'general');
        break;
    }
  };

  const saveDraft = async (): Promise<boolean> => {
    const current = state;

    if (current === null) {
      return false;
    }

    if (!current.dirty) {
      return true;
    }

    // The hub refuses a draft of a file that changed on disk; the bar says to Discard.
    if (current.changedOnDisk) {
      return false;
    }

    if (checkedEdits !== edits) {
      cancelCheck();
      await check();
    }

    if (state !== current) {
      return false;
    }

    if (current.errors.length > 0) {
      current.barErrors = current.errors;
      draw();
      return false;
    }

    const sent = clone(current.draft!);

    current.saving = true;
    draw();

    let answer: Answer;

    try {
      answer = await deps.post('page-settings-save', { value: sent, version: current.draftVersion, configDir: current.config.configDir });
    } finally {
      current.saving = false;
    }

    if (state !== current) {
      return false;
    }

    if (answer.status !== 200) {
      current.barErrors = Array.isArray(answer.body['errors']) ? (answer.body['errors'] as unknown[]).map(String) : [String(answer.body['error'] ?? 'Switchboard did not answer.')];
      draw();
      return false;
    }

    current.barErrors = [];

    if (typeof answer.body['version'] === 'string') {
      // Until the read answers, the file is taken to hold what was sent at the version written, so an edit made meanwhile builds on it.
      current.wrote(sent, answer.body['version']);
    } else if (JSON.stringify(current.draft) === JSON.stringify(sent)) {
      current.dropDraft();
    }

    draw();
    await load();
    return true;
  };

  /** Saves the draft when it differs from the file; a Save during another waits for it. True when the file holds the draft. */
  const save = async (): Promise<boolean> => {
    if (saving !== null) {
      await saving;
      return state !== null && !state.dirty;
    }

    saving = saveDraft();

    try {
      return await saving;
    } finally {
      saving = null;
    }
  };

  const closeNow = (): void => {
    cancelCheck();
    view.open = false;
    view.ask = null;
    // The draft goes with Settings, as with the dock's window.
    state = null;
    loads++;
    draw();
    deps.closed?.();
  };

  const requestClose = (): void => {
    if (state?.dirty === true) {
      view.ask = { kind: 'close' };
      draw();
      host.querySelector<HTMLElement>('.settings-ask .sheet-button.primary')?.focus();
      return;
    }

    closeNow();
  };

  const navigate = (page: string): void => {
    if (state === null) {
      return;
    }

    state.page = page;
    view.drill = 'page';
    redraw();
    host.querySelector<HTMLElement>('.settings-page')?.scrollTo?.({ top: 0 });

    // On a phone the navigation, which had the focus, is hidden now, so the page's title takes it.
    if (phone()) {
      host.querySelector<HTMLElement>('.settings-page-title h2')?.focus();
    }
  };

  const handlers: Handlers = {
    navigate,
    back: () => {
      view.drill = 'nav';
      draw();
      host.querySelector<HTMLElement>('.settings-nav-entry.current, .settings-nav-entry')?.focus();
    },
    close: requestClose,
    edit,
    toggleSection: (key) => {
      if (view.opened.has(key)) {
        view.opened.delete(key);
      } else {
        view.opened.add(key);
      }

      draw();
    },
    toggleHelp: (path) => {
      if (view.help.has(path)) {
        view.help.delete(path);
      } else {
        view.help.add(path);
      }

      draw();
    },
    button,
    addSource,
    editName,
    save: async () => {
      const ok = await save();

      // A change made while the save ran stays open as unsaved.
      if (ok && state !== null && !state.dirty && view.open) {
        closeNow();
      }
    },
    saveStay: () => void save(),
    discard: closeNow,
    editCell,
    answer: async (choice) => {
      const asked = view.ask;

      view.ask = null;

      if (asked?.kind === 'delete') {
        const value = state?.value ?? null;

        if (choice === 'delete' && state !== null && value !== null && state.hasPlaybook(asked.name)) {
          state.setDraft(withPlaybook(value, asked.name, undefined));
          state.page = 'general';
          view.typing.clear();
          edited();
          // The page's title takes the focus from the closed question's button.
          host.querySelector<HTMLElement>('.settings-page-title h2')?.focus();
        } else {
          draw();
          [...host.querySelectorAll<HTMLButtonElement>('.settings-buttons button')].find((one) => one.textContent === 'Delete')?.focus();
        }

        return;
      }

      if (choice === 'save') {
        if (await save()) {
          closeNow();
        }

        return;
      }

      if (choice === 'discard') {
        closeNow();
        return;
      }

      draw();
    },
  };

  host.addEventListener('keydown', (event) => {
    if (!view.open) {
      return;
    }

    // The page's own keys, such as Escape for a sheet or the voice, do not reach through Settings.
    event.stopPropagation();

    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
      // Ctrl+S saves from any field and keeps Settings open, as the dock's.
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      if (view.ask !== null) {
        void handlers.answer('keep');
      } else {
        requestClose();
      }
    }
  });

  return {
    open: () => {
      if (view.open) {
        return;
      }

      view.open = true;
      view.drill = 'nav';
      view.notice = null;
      view.error = null;
      redraw();
      host.querySelector<HTMLElement>('.settings-nav button.current, .settings-close')?.focus();
      void load();
    },
    requestClose,
    isOpen: () => view.open,
    state: () => state,
    reload: () => (view.open && state?.saving !== true ? load() : Promise.resolve()),
  };
}

interface Handlers {
  navigate(page: string): void;
  back(): void;
  close(): void;
  edit(field: Field, input: string, checked?: boolean): void;
  toggleSection(key: string): void;
  toggleHelp(path: string): void;
  button(button: PageButton): void;
  addSource(kind: string): void;
  editName(part: 'name' | 'kind' | 'namespace', text: string): void;
  save(): void;
  saveStay(): void;
  discard(): void;
  answer(choice: 'save' | 'discard' | 'keep' | 'delete'): void;
  editCell(name: string, path: string, checked: boolean): void;
}

/** Settings: its header, the navigation and the page side by side (on a phone, one of them), and the bar under both. */
export function renderSettings(state: EditorState | null, view: View, on: Handlers): VNode {
  const page = state === null ? null : pageView(state);
  const shown = bar(state ?? new EditorState({ settings: { path: '', version: null, value: {}, error: null }, permissionModes: [], codexPermissionModes: [], providers: [], templateVariables: [], sourceKinds: [], inUse: {}, enabled: {}, configDir: '' }));

  return (
    <div class="settings" data-drill={view.drill} role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div class="settings-head">
        <button type="button" class="icon settings-back" aria-label="All settings" title="All settings" onClick={on.back}>
          <span class="codicon codicon-chevron-left" aria-hidden="true"></span>
        </button>
        <h1 id="settings-title" class="settings-title">
          Settings
        </h1>
        <button type="button" class="icon settings-close" aria-label="Close settings" title="Close settings" onClick={on.close}>
          <span class="codicon codicon-close" aria-hidden="true"></span>
        </button>
      </div>
      <div class="settings-body">
        <nav class="settings-nav" aria-label="Settings pages">
          {state === null ? <p class="settings-message settings-nav-message">{view.error ?? 'Reading the settings…'}</p> : nav(state).map((entry) => <NavRow entry={entry} on={on} />)}
        </nav>
        <div class="settings-page">
          {view.notice === null ? null : <p class="settings-notice">{view.notice}</p>}
          {page === null ? <p class="settings-message">{view.error ?? 'Reading the settings…'}</p> : <Page state={state!} page={page} view={view} on={on} />}
        </div>
      </div>
      {state === null ? null : (
        <div class="settings-bar">
          <div class="settings-bar-text">
            <span class="settings-status">{shown.status}</span>
            {shown.warning === null ? null : <span class="settings-warning">{shown.warning}</span>}
            {shown.errors.map((error) => (
              <span class="settings-error">{error}</span>
            ))}
          </div>
          <div class="settings-bar-buttons">
            <button type="button" class="sheet-button secondary" title="Drop every unsaved change and close settings" disabled={!shown.canDiscard} onClick={on.discard}>
              Discard
            </button>
            <button type="button" class="sheet-button primary" title="Save settings and close (Ctrl+S saves and stays open)" disabled={!shown.canSave} onClick={on.save}>
              Save
            </button>
          </div>
        </div>
      )}
      {view.ask === null ? null : <AskSheet ask={view.ask} on={on} />}
    </div>
  );
}

function NavRow({ entry, on }: { entry: NavEntry; on: Handlers }) {
  if (entry.kind === 'heading') {
    return <h2 class="settings-nav-heading">{entry.label}</h2>;
  }

  return (
    <button type="button" class={`settings-nav-entry ${entry.kind}${entry.current ? ' current' : ''}`} aria-current={entry.current ? 'page' : undefined} onClick={() => (entry.addSource !== undefined ? on.addSource(entry.addSource) : entry.page !== undefined && on.navigate(entry.page))}>
      <span class="settings-nav-label">{entry.kind === 'add' ? `+ ${entry.label}` : entry.label}</span>
      {entry.note === undefined ? null : <span class="settings-nav-note">{entry.note}</span>}
      {entry.dirty ? (
        <span class="settings-dirty" title="Unsaved changes" aria-label="Unsaved changes">
          ●
        </span>
      ) : null}
      {entry.errors ? (
        <span class="settings-errors" title="Errors" aria-label="Errors">
          ⚠
        </span>
      ) : null}
      <span class="codicon codicon-chevron-right settings-drill" aria-hidden="true"></span>
    </button>
  );
}

function Page({ state, page, view, on }: { state: EditorState; page: PageView; view: View; on: Handlers }) {
  return (
    <>
      <div class="settings-page-head">
        <div class="settings-page-title">
          <h2 tabIndex={-1}>{page.title}</h2>
          {page.filePath === null ? null : (
            <span class="settings-file" title={page.filePath}>
              {page.filePath}
            </span>
          )}
        </div>
        <div class="settings-buttons">
          {page.buttons.map((button) => (
            <button type="button" class={`sheet-button ${button.primary === true ? 'primary' : 'secondary'}`} title={button.tip} onClick={() => on.button(button)}>
              {button.label}
            </button>
          ))}
        </div>
      </div>
      {page.notes.map((note) => (
        <p class="settings-note">{note}</p>
      ))}
      {page.errors.map((error) => (
        <p class="settings-error" role="alert">
          {error}
        </p>
      ))}
      {page.message === null ? null : <p class="settings-message">{page.message}</p>}
      {page.newName === undefined ? null : <NameFields names={page.newName} view={view} on={on} />}
      {page.table === undefined ? null : <Table table={page.table} on={on} />}
      {page.sections.map((section) => (
        <SectionBlock state={state} section={section} view={view} on={on} />
      ))}
    </>
  );
}

function SectionBlock({ state, section, view, on }: { state: EditorState; section: SectionView; view: View; on: Handlers }) {
  const rows = runs(section.fields).map((run) => (run.length > 1 || run[0]!.field.group !== undefined ? <GroupRow views={run} on={on} /> : <FieldRow field={run[0]!} view={view} on={on} />));

  if (!section.advanced) {
    return (
      <section class="settings-section">
        {section.heading === '' ? null : <h3 class="settings-section-heading">{section.heading}</h3>}
        {rows}
      </section>
    );
  }

  const key = `${state.page}/${section.heading}`;

  // A new error inside a collapsed Advanced section opens it; the operator can close it again.
  for (const field of section.fields) {
    if (field.errors.length > 0 && !view.erred.has(field.field.path)) {
      view.opened.add(key);
    }
  }

  for (const field of section.fields) {
    if (field.errors.length > 0) {
      view.erred.add(field.field.path);
    } else {
      view.erred.delete(field.field.path);
    }
  }

  const open = view.opened.has(key);

  return (
    <section class="settings-section advanced">
      <button type="button" class="settings-section-heading settings-toggle" aria-expanded={open} onClick={() => on.toggleSection(key)}>
        <span class={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true"></span>
        {section.heading}
      </button>
      {open ? rows : null}
    </section>
  );
}

/** A namespace's playbooks as rows of checkboxes under grouped column headers; a row's name opens its page. */
function Table({ table, on }: { table: PlaybookTable; on: Handlers }) {
  const groups: Array<{ group: string | null; span: number }> = [];

  for (const column of table.columns) {
    const last = groups[groups.length - 1];

    if (last !== undefined && last.group === column.group) {
      last.span++;
    } else {
      groups.push({ group: column.group, span: 1 });
    }
  }

  return (
    <div class="settings-table-scroll">
      <table class="settings-table">
        <thead>
          {table.columns.some((column) => column.group !== null) ? (
            <tr>
              <th></th>
              {groups.map((one) => (
                <th colSpan={one.span} class={one.group === null ? undefined : 'settings-table-group'}>
                  {one.group ?? ''}
                </th>
              ))}
            </tr>
          ) : null}
          <tr>
            <th class="settings-table-name">Name</th>
            {table.columns.map((column) => (
              <th title={column.help}>{column.label}</th>
            ))}
          </tr>
        </thead>
        {table.rows.map((row) => (
          <tbody data-playbook={row.name}>
            <tr>
              <td class="settings-table-name">
                <button type="button" class="link" title={row.description === '' ? undefined : row.description} onClick={() => on.navigate(`playbook:${row.name}`)}>
                  {row.label}
                </button>
                {row.dirty ? (
                  <span class="settings-dirty" title="Unsaved changes" aria-label="Unsaved changes">
                    ●
                  </span>
                ) : null}
              </td>
              {row.cells.map((cell, index) => (
                <td>
                  {cell === null ? null : (
                    <input
                      type="checkbox"
                      aria-label={`${row.label}: ${table.columns[index]!.label}`}
                      checked={cell.checked}
                      disabled={!cell.enabled}
                      onChange={(event) => on.editCell(row.name, table.columns[index]!.path, (event.currentTarget as HTMLInputElement).checked)}
                    />
                  )}
                </td>
              ))}
            </tr>
            {row.errors.length === 0 ? null : (
              <tr>
                <td colSpan={table.columns.length + 1}>
                  <Errors errors={row.errors} />
                </td>
              </tr>
            )}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** A copy of `root` with a playbook entry set, or removed when `entry` is undefined; an edited entry keeps its place. */
function withPlaybook(root: JsonObject, name: string, entry: Json | undefined): JsonObject {
  const copy = clone(root);
  const playbooks: JsonObject = typeof copy['playbooks'] === 'object' && copy['playbooks'] !== null && !Array.isArray(copy['playbooks']) ? copy['playbooks'] : (copy['playbooks'] = {});

  if (entry === undefined) {
    delete playbooks[name];
  } else {
    playbooks[name] = clone(entry);
  }

  return copy;
}

/** Splits fields into runs: each checkbox group's adjacent fields together, every other field alone. */
function runs(fields: readonly FieldView[]): FieldView[][] {
  const out: FieldView[][] = [];

  for (const field of fields) {
    const last = out[out.length - 1];

    if (field.field.group !== undefined && last !== undefined && last[0]!.field.group === field.field.group) {
      last.push(field);
    } else {
      out.push([field]);
    }
  }

  return out;
}

const inputId = (path: string): string => `settings-field-${path.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** A field's info icon, which shows its help in its tooltip and, tapped, under the field, so a phone can read it too. */
function Info({ field, on }: { field: Field; on: Handlers }) {
  return field.help === '' ? null : (
    <button type="button" class="icon settings-info" title={field.help} aria-label={`About ${field.label}`} onClick={() => on.toggleHelp(field.path)}>
      <span class="codicon codicon-info" aria-hidden="true"></span>
    </button>
  );
}

function Errors({ errors }: { errors: readonly string[] }) {
  return (
    <>
      {errors.map((error) => (
        <span class="settings-field-error" role="alert">
          {error}
        </span>
      ))}
    </>
  );
}

function FieldRow({ field: shown, view, on }: { field: FieldView; view: View; on: Handlers }) {
  const { field } = shown;
  const id = inputId(field.path);
  const help = view.help.has(field.path) && field.help !== '' ? <p class="settings-help">{field.help}</p> : null;

  return (
    <div class={`settings-row ${field.kind}`} data-path={field.path}>
      <div class="settings-caption">
        <label for={id}>{field.label}</label>
        <Info field={field} on={on} />
      </div>
      <div class="settings-input">
        <Input shown={shown} id={id} typed={view.typing.get(field.path)} on={on} />
        {help}
        <Errors errors={shown.errors} />
      </div>
    </div>
  );
}

function Input({ shown, id, typed, on }: { shown: FieldView; id: string; typed: string | undefined; on: Handlers }) {
  const { field } = shown;

  if (field.kind === 'boolean') {
    return <input type="checkbox" id={id} checked={shown.checked} onChange={(event) => on.edit(field, '', (event.currentTarget as HTMLInputElement).checked)} />;
  }

  if (field.kind === 'select') {
    const options = field.options ?? [];
    const chosen = typed ?? shown.selected;

    return (
      <select id={id} class="sheet-select settings-select" onChange={(event) => on.edit(field, (event.currentTarget as HTMLSelectElement).value)}>
        {options.some((option) => option.value === chosen) ? null : <option value={chosen} selected hidden></option>}
        {options.map((option) => (
          <option value={option.value} selected={option.value === chosen}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  const value = typed ?? shown.text;

  if (field.kind === 'list' || field.kind === 'prompt') {
    // A multiline box grows with its text up to 20 lines for a prompt and 8 for a list, then scrolls.
    const rows = Math.max(field.kind === 'prompt' ? 4 : 2, Math.min(field.kind === 'prompt' ? 20 : 8, value.split('\n').length + 1));

    return <textarea id={id} class={`settings-text ${field.kind}`} rows={rows} placeholder={field.placeholder} value={value} onInput={(event) => on.edit(field, (event.currentTarget as HTMLTextAreaElement).value)}></textarea>;
  }

  const numeric = field.kind === 'integer' || field.kind === 'number';

  return (
    <input
      type="text"
      id={id}
      class={`settings-text${numeric ? ' numeric' : ''}`}
      inputMode={field.kind === 'integer' ? 'numeric' : field.kind === 'number' ? 'decimal' : undefined}
      placeholder={field.placeholder}
      value={value}
      spellcheck={false}
      onInput={(event) => on.edit(field, (event.currentTarget as HTMLInputElement).value)}
    />
  );
}

/** A checkbox group's row: one checkbox per field, labelled with its own name and explained by its tooltip. */
function GroupRow({ views, on }: { views: FieldView[]; on: Handlers }) {
  const first = views[0]!.field;

  return (
    <div class="settings-row group">
      <div class="settings-caption">
        <span>{first.group ?? first.label}</span>
      </div>
      <div class="settings-input settings-group">
        {views.map((shown) => (
          <span class="settings-check" title={shown.field.help === '' ? undefined : shown.field.help}>
            <input type="checkbox" id={inputId(shown.field.path)} checked={shown.checked} onChange={(event) => on.edit(shown.field, '', (event.currentTarget as HTMLInputElement).checked)} />
            <label for={inputId(shown.field.path)}>{shown.field.label}</label>
            <Errors errors={shown.errors} />
          </span>
        ))}
      </div>
    </div>
  );
}

const KIND_FIELD: Field = { path: 'new-kind', label: 'Kind', kind: 'select', help: 'The plugin that reads the source. A second source of one kind, such as another GitHub repository, needs a name of its own.' };

/** A New page's name, with a source's kind or a playbook's namespace, and the name's error. */
function NameFields({ names, view, on }: { names: NewNameView; view: View; on: Handlers }) {
  const nameField: Field = { path: 'new-name', label: names.label, kind: 'text', help: names.help };
  const name = (
    <div class="settings-input">
      <span class="settings-name">
        {names.namespace === undefined ? null : (
          <>
            <input type="text" id="settings-new-namespace" class="settings-text settings-namespace" aria-label="Namespace" placeholder="dev" list="settings-namespaces" value={names.namespace} spellcheck={false} onInput={(event) => on.editName('namespace', (event.currentTarget as HTMLInputElement).value)} />
            <datalist id="settings-namespaces">
              {(names.namespaces ?? []).map((one) => (
                <option value={one}></option>
              ))}
            </datalist>
            <span>:</span>
          </>
        )}
        <input type="text" id="settings-new-name" class="settings-text" placeholder={names.placeholder} value={names.name} spellcheck={false} onInput={(event) => on.editName('name', (event.currentTarget as HTMLInputElement).value)} />
      </span>
      {view.help.has(nameField.path) ? <p class="settings-help">{names.help}</p> : null}
      <Errors errors={names.error === null ? [] : [names.error]} />
    </div>
  );

  return (
    <section class="settings-section">
      {names.kinds === undefined ? null : (
        <div class="settings-row" data-path="new-kind">
          <div class="settings-caption">
            <label for="settings-new-kind">Kind</label>
            <Info field={KIND_FIELD} on={on} />
          </div>
          <div class="settings-input">
            <select id="settings-new-kind" class="sheet-select settings-select" onChange={(event) => on.editName('kind', (event.currentTarget as HTMLSelectElement).value)}>
              {names.kinds.map((kind) => (
                <option value={kind.value} selected={kind.value === names.kind}>
                  {kind.label}
                </option>
              ))}
            </select>
            {view.help.has(KIND_FIELD.path) ? <p class="settings-help">{KIND_FIELD.help}</p> : null}
          </div>
        </div>
      )}
      <div class="settings-row" data-path="new-name">
        <div class="settings-caption">
          <label for="settings-new-name">{names.label}</label>
          <Info field={nameField} on={on} />
        </div>
        {name}
      </div>
    </section>
  );
}

/** Asks before closing over unsaved changes: Save closes once the file holds them, Discard closes, and Keep editing stays. */
function AskSheet({ ask, on }: { ask: Ask; on: Handlers }) {
  if (ask.kind === 'delete') {
    return (
      <div class="sheet-backdrop settings-ask" onClick={(event) => event.target === event.currentTarget && on.answer('keep')}>
        <div class="sheet glass" role="alertdialog" aria-modal="true" aria-labelledby="settings-ask-title">
          <h2 id="settings-ask-title" class="sheet-title">
            Delete playbook {ask.name}?
          </h2>
          <p class="sheet-detail">{ask.detail}</p>
          <div class="sheet-buttons">
            <button type="button" class="sheet-button secondary" onClick={() => on.answer('keep')}>
              Cancel
            </button>
            <button type="button" class="sheet-button primary danger" onClick={() => on.answer('delete')}>
              Delete
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="sheet-backdrop settings-ask" onClick={(event) => event.target === event.currentTarget && on.answer('keep')}>
      <div class="sheet glass" role="alertdialog" aria-modal="true" aria-labelledby="settings-ask-title">
        <h2 id="settings-ask-title" class="sheet-title">
          Save changes to settings?
        </h2>
        <p class="sheet-detail">Your changes are lost if you don't save them.</p>
        <div class="sheet-buttons">
          <button type="button" class="sheet-button secondary" onClick={() => on.answer('discard')}>
            Discard
          </button>
          <button type="button" class="sheet-button secondary" onClick={() => on.answer('keep')}>
            Keep editing
          </button>
          <button type="button" class="sheet-button primary" onClick={() => on.answer('save')}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

