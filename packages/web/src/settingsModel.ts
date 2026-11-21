// The web page's Settings (architecture.md § Web page, PRD R54): the dock's Settings window's state, fields and pages, ported from
// apps/dock/src/Switchboard.Dock/Settings, so the page edits settings.json as the dock does and shows the same pages, fields and errors.

/** A JSON value as settings.json holds it. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type FieldKind = 'text' | 'integer' | 'number' | 'boolean' | 'select' | 'list' | 'prompt';

export interface FieldOption {
  value: string;
  label: string;
}

/**
 * A setting or playbook field, as the dock's `Field`: `path` is a dotted path from the settings root, or a playbook field name; `help` explains
 * it, empty for none; `placeholder` is the value that applies when it is empty; `fallback` a checkbox's value when the key is absent;
 * `listDefault` a list whose default is not empty, so an absent key shows the default and an emptied list is saved as `[]`. Adjacent checkboxes
 * with the same `group` share one row under that label.
 */
export interface Field {
  path: string;
  label: string;
  kind: FieldKind;
  help: string;
  placeholder?: string;
  options?: readonly FieldOption[];
  fallback?: boolean;
  listDefault?: readonly string[];
  group?: string;
}

/** A page section; an `advanced` one starts collapsed. */
export interface Section {
  heading: string;
  fields: readonly Field[];
  advanced?: boolean;
}

/** settings.json as the hub read it: its value, or null and the error when it is not valid JSON. */
export interface SettingsFile {
  path: string;
  version: string | null;
  value: Json | undefined;
  error: string | null;
}

/** What `page-settings-read` answers, as `/config/read` answers the dock. */
export interface EditorConfig {
  settings: SettingsFile;
  permissionModes: readonly string[];
  codexPermissionModes: readonly string[];
  providers: readonly string[];
  templateVariables: readonly string[];
  sourceKinds: readonly string[];
  inUse: Readonly<Record<string, number>>;
  enabled: Readonly<Record<string, boolean>>;
  configDir: string;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map((entry) => (typeof entry === 'string' ? entry : '')) : []);
const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Reads the hub's answer, as the dock's `EditorConfig.Parse`. */
export function parseConfig(body: Record<string, unknown>): EditorConfig {
  const settings = isObject(body['settings']) ? body['settings'] : {};
  const record = <T>(value: unknown, read: (entry: unknown) => T): Record<string, T> => (isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, read(entry)])) : {});

  return {
    settings: { path: text(settings['path']) ?? '', version: text(settings['version']), value: settings['value'] === undefined ? undefined : clone(settings['value']), error: text(settings['error']) },
    permissionModes: strings(body['permissionModes']),
    codexPermissionModes: strings(body['codexPermissionModes']),
    providers: strings(body['providers']),
    templateVariables: strings(body['templateVariables']),
    sourceKinds: strings(body['sourceKinds']),
    inUse: record(body['inUse'], (entry) => (typeof entry === 'number' ? entry : 0)),
    enabled: record(body['enabled'], (entry) => entry === true),
    configDir: text(body['configDir']) ?? '',
  };
}

export function clone<T extends Json | undefined>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** A value's JSON text, `undefined` for an absent one, to compare two values as the dock does. */
export const json = (value: Json | undefined): string => (value === undefined ? 'undefined' : JSON.stringify(value));

export const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

const ASSIGNMENTS = 'voice.playbookPersonas.';

/** A path's segments; a `voice.playbookPersonas` key is a playbook name, which may hold a dot, so it stays one segment. */
function segments(path: string): string[] {
  return path.startsWith(ASSIGNMENTS) && path.length > ASSIGNMENTS.length ? ['voice', 'playbookPersonas', path.slice(ASSIGNMENTS.length)] : path.split('.');
}

/** A path segment's key and, for a list entry such as `personas[0]`, its index. */
function step(segment: string): { key: string; index: number | null } {
  const match = /^(.+)\[(\d+)\]$/.exec(segment);

  return match === null ? { key: segment, index: null } : { key: match[1]!, index: Number(match[2]) };
}

/** The value at a dotted path, whose segments may index a list, as in `voice.personas[0].name`; undefined when any part is missing. */
export function getAt(root: Json | undefined, path: string): Json | undefined {
  let node: Json | undefined = root;

  for (const segment of segments(path)) {
    const { key, index } = step(segment);

    node = isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined;

    if (index !== null) {
      node = Array.isArray(node) && index < node.length ? node[index] : undefined;
    }
  }

  return node;
}

/**
 * A copy of `root` with `path` set, or removed when `value` is undefined; intermediate objects are created. A list entry on the path, as in
 * `voice.personas[0].name`, must exist and, when not last, be an object; otherwise nothing changes.
 */
export function setAt(root: JsonObject, path: string, value: Json | undefined): JsonObject {
  const copy = clone(root);
  const keys = segments(path);
  let parent: JsonObject = copy;

  for (const segment of keys.slice(0, -1)) {
    const { key, index } = step(segment);

    if (index !== null) {
      const list = parent[key];
      const entry = Array.isArray(list) && index < list.length ? list[index] : undefined;

      if (!isObject(entry)) {
        return clone(root);
      }

      parent = entry;
      continue;
    }

    const child = parent[key];

    if (isObject(child)) {
      parent = child;
    } else {
      const created: JsonObject = {};

      parent[key] = created;
      parent = created;
    }
  }

  const { key: last, index } = step(keys[keys.length - 1]!);

  if (index !== null) {
    const list = parent[last];

    if (!Array.isArray(list) || index >= list.length) {
      return clone(root);
    }

    if (value === undefined) {
      list.splice(index, 1);
    } else {
      list[index] = clone(value);
    }

    return copy;
  }

  if (value === undefined) {
    delete parent[last];
  } else {
    parent[last] = clone(value);
  }

  return copy;
}

/** Reads a settings field's input; undefined removes the key, so the default applies. Text that is not a number is kept, so the check names the field. */
export function readField(kind: FieldKind, input: string, checked = false, keepEmpty = false): Json | undefined {
  const trimmed = input.trim();

  switch (kind) {
    case 'boolean':
      return checked;
    case 'integer':
      return trimmed === '' ? undefined : /^-?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed)) ? Number(trimmed) : input;
    case 'number':
      return trimmed === '' ? undefined : /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : input;
    case 'list': {
      const lines = input.split('\n').map((line) => line.trim()).filter((line) => line !== '');

      return lines.length === 0 && !keepEmpty ? undefined : lines;
    }
    default:
      return input === '' ? undefined : input;
  }
}

/** The choices for a select, keeping a configured value that is not among them. */
export function withCurrent(options: readonly FieldOption[], current: Json | undefined): FieldOption[] {
  return typeof current === 'string' && current !== '' && !options.some((option) => option.value === current) ? [...options, { value: current, label: `${current} (missing)` }] : [...options];
}

/** A provider's name on the page. */
export const providerName = (provider: string): string => (provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider);

/**
 * The Settings state, as the dock's `EditorState`: settings.json as read, one unsaved draft of the whole file with the version it started
 * from, the page, and the errors. Pages are `general`, and those the later parts of this file add.
 */
export class EditorState {
  page = 'general';
  /** The unsaved settings.json, or null when there are no unsaved changes. */
  draft: JsonObject | null = null;
  /** The file version the draft started from, null for a missing file. */
  draftVersion: string | null = null;
  /** The last check's errors for the whole draft. */
  errors: string[] = [];
  /** A refused save's errors, or the check errors that stopped a save; shown in the bar until the next edit, discard or successful save. */
  barErrors: string[] = [];
  saving = false;
  /** The name typed and kind chosen on the New source page, empty for the first kind, and whether Create was pressed. */
  newSource = { name: '', kind: '', touched: false };

  constructor(public config: EditorConfig) {}

  /** The playbook being created on the New playbook page; `touched` once Create was pressed, so an empty name shows its error. */
  newPlaybook: NewPlaybook = emptyNewPlaybook();

  /** A playbook's entry as the file holds it. */
  fileEntry(name: string): Json | undefined {
    const playbooks = isObject(this.config.settings.value) ? this.config.settings.value['playbooks'] : undefined;

    return isObject(playbooks) && Object.hasOwn(playbooks, name) ? playbooks[name] : undefined;
  }

  playbookDirty(name: string): boolean {
    const file = isObject(this.config.settings.value) ? this.config.settings.value['playbooks'] : undefined;
    const onDisk = isObject(file) && Object.hasOwn(file, name) ? JSON.stringify(file[name]) : 'absent';
    const drafted = this.hasPlaybook(name) ? JSON.stringify(this.playbookEntry(name) ?? null) : 'absent';

    return this.draft !== null && drafted !== onDisk;
  }

  /** The playbooks of a namespace, sorted. */
  namespacePlaybooks(space: string): string[] {
    return this.playbookNames.filter((name) => name.split(':')[0] === space);
  }

  /** The check errors of one playbook, without their `playbooks.<name>: ` prefix. */
  playbookErrors(name: string): string[] {
    const prefix = `playbooks.${name}: `;

    return this.errors.filter((error) => error.startsWith(prefix)).map((error) => error.slice(prefix.length));
  }

  /** Why the new playbook's name cannot be used, or null. */
  get newNameError(): string | null {
    if (!SEGMENT.test(this.newPlaybook.namespace.trim()) || !SEGMENT.test(this.newPlaybook.name.trim())) {
      return 'Namespace and name must be lowercase letters, digits and hyphens.';
    }

    const value = this.value;

    if (value === null || (value['playbooks'] !== undefined && !isObject(value['playbooks']))) {
      return 'settings.json must hold an object with a playbooks object.';
    }

    const full = newPlaybookName(this.newPlaybook);

    return this.hasPlaybook(full) ? `A playbook named ${full} already exists.` : null;
  }

  /** The check errors that belong to no playbook in the draft, which the settings pages place. */
  get settingsErrors(): string[] {
    const prefixes = this.playbookNames.map((name) => `playbooks.${name}: `);

    return this.errors.filter((error) => !prefixes.some((prefix) => error.startsWith(prefix)));
  }

  /** The New source page's kind: the one chosen, else the first the hub offers. */
  get newSourceKind(): string {
    return this.newSource.kind !== '' ? this.newSource.kind : (this.config.sourceKinds[0] ?? '');
  }

  /** The playbook names in the settings being edited, sorted. */
  get playbookNames(): string[] {
    const playbooks = this.value?.['playbooks'];

    return isObject(playbooks) ? Object.keys(playbooks).sort(ordinal) : [];
  }

  playbookEntry(name: string): Json | undefined {
    const playbooks = this.value?.['playbooks'];

    return isObject(playbooks) && Object.hasOwn(playbooks, name) ? playbooks[name] : undefined;
  }

  hasPlaybook(name: string): boolean {
    const playbooks = this.value?.['playbooks'];

    return isObject(playbooks) && Object.hasOwn(playbooks, name);
  }

  /** A playbook's fields, or null when it is absent or its entry cannot be read. */
  playbookValue(name: string): PlaybookFields | null {
    return this.hasPlaybook(name) ? readPlaybook(this.playbookEntry(name)).fields : null;
  }

  /** The namespaces of the playbooks, sorted. */
  get namespaces(): string[] {
    return [...new Set(this.playbookNames.map((name) => name.split(':')[0]!))];
  }

  /** The source names in the settings being edited, in file order. */
  get sourceNames(): string[] {
    const sources = this.value?.['sources'];

    return isObject(sources) ? Object.keys(sources) : [];
  }

  /** Why the new source's name cannot be used, or null. */
  get newSourceError(): string | null {
    const name = this.newSource.name.trim();

    if (!SEGMENT.test(name)) {
      return 'The name must be lowercase letters, digits and hyphens.';
    }

    if (name === 'schedule' || name === 'adhoc') {
      return `${name} names Switchboard's own tickets; choose another name.`;
    }

    const value = this.value;

    if (value === null || (value['sources'] !== undefined && !isObject(value['sources']))) {
      return 'settings.json must hold an object with a sources object.';
    }

    return this.sourceNames.includes(name) ? `A source named ${name} already exists.` : null;
  }

  /** The settings being edited: the draft, else the file's object, else null when the file holds no object. */
  get value(): JsonObject | null {
    return this.draft ?? (isObject(this.config.settings.value) ? this.config.settings.value : null);
  }

  /** Replaces the draft; the first change records the file version it starts from. */
  setDraft(value: JsonObject): void {
    if (this.draft === null) {
      this.draftVersion = this.config.settings.version;
    }

    this.draft = value;
  }

  dropDraft(): void {
    this.draft = null;
    this.draftVersion = null;
  }

  get dirty(): boolean {
    return this.draft !== null && JSON.stringify(this.draft) !== (this.config.settings.value === undefined ? 'null' : JSON.stringify(this.config.settings.value));
  }

  /** Whether settings.json changed on disk after the draft started, so the hub refuses to save the draft. */
  get changedOnDisk(): boolean {
    return this.draft !== null && this.draftVersion !== this.config.settings.version;
  }

  /** Takes a successful save of `sent` at `version`; a draft edited since continues from that version. */
  wrote(sent: JsonObject, version: string): void {
    this.config = { ...this.config, settings: { ...this.config.settings, version, value: clone(sent), error: null } };

    if (this.draft !== null && JSON.stringify(this.draft) === JSON.stringify(sent)) {
      this.dropDraft();
    } else if (this.draft !== null) {
      this.draftVersion = version;
    }
  }

  /** Takes the file read again. A draft that matches the old or the new file holds no edit and is dropped; any other draft is kept, so no edit is lost. */
  refresh(config: EditorConfig): void {
    const unchanged = !this.dirty;

    this.config = config;

    if (unchanged || !this.dirty) {
      this.dropDraft();
    }
  }

  /** What the page shows from the file and draft; equal before and after a read that changes nothing there. */
  signature(): string {
    return [this.page, this.config.configDir, JSON.stringify(this.value), this.config.settings.path, this.config.settings.error].join('\n');
  }
}

/** Sorts as .NET's ordinal comparison does, by UTF-16 code unit. */
export const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A playbook entry of settings.json's `playbooks` object, as the dock's `PlaybookFields`. */
export interface PlaybookFields {
  description: string;
  kind: string;
  autoStart: boolean;
  requiresWorktree: boolean;
  permissionMode: string | null;
  model: string | null;
  workdir: string;
  reports: string[];
  approvalSends: boolean;
  rates: boolean;
  returnOf: string[];
  template: string;
  provider: string | null;
  focus: string | null;
}

export const EMPTY_PLAYBOOK: PlaybookFields = { description: '', kind: 'task', autoStart: false, requiresWorktree: false, permissionMode: null, model: null, workdir: 'worktree', reports: [], approvalSends: false, rates: false, returnOf: [], template: '', provider: null, focus: null };

/** The New playbook page's namespace, name and playbook, and whether Create was pressed. */
export interface NewPlaybook {
  namespace: string;
  name: string;
  playbook: PlaybookFields;
  touched: boolean;
}

export const emptyNewPlaybook = (): NewPlaybook => ({ namespace: '', name: '', playbook: EMPTY_PLAYBOOK, touched: false });

export const newPlaybookName = (draft: NewPlaybook): string => `${draft.namespace.trim()}:${draft.name.trim()}`;

/** The reports a task playbook can list, in the order the page writes them. */
export const REPORT_KINDS = ['done', 'approval', 'worktree', 'playbook', 'paste'];

/** The reports a task session can send, as checkbox labels and tooltips. */
export const REPORT_FIELDS: ReadonlyArray<{ kind: string; label: string; help: string }> = [
  { kind: 'done', label: 'Done', help: 'The session closes the work item. Off, its turn ends in Ready for review.' },
  { kind: 'approval', label: 'Approval', help: 'The session can leave a prompt for you to approve, such as one that posts its draft.' },
  { kind: 'worktree', label: 'Worktree', help: 'The session can link a worktree it creates. Branch names link worktrees without it.' },
  { kind: 'playbook', label: 'Playbook', help: 'The session can hand its work item to another playbook in the namespace, whose skill it runs.' },
  { kind: 'paste', label: 'Paste', help: 'The session can name drafted texts, such as a customer reply, that Copy puts on the clipboard on its approval row.' },
];

export const AUTO_START_HELP = 'Start the session after triage, unless nothing is newer than the ticket’s earlier work item. Off, the work item waits in Unstarted for you to start it.';
export const REQUIRES_WORKTREE_HELP = 'Run the source’s setup prompt first when the ticket has no worktree.';
export const FOCUS_HELP = 'The page an item window opens for this playbook’s work, at the earliest comment there that asks for it.';
export const RETURN_OF_HELP = 'One playbook per line, such as dev:review-pr for dev:review-pr-followup. Returned also counts the ticket’s earlier work items with these playbooks.';
export const APPROVAL_SENDS_HELP = 'Approve posts or pushes the session’s work. Off, you send it yourself, such as by pasting a reply, and Approve finishes up.';
export const RATES_HELP = 'Triage stores immediacy and severity, which these instructions must define. Off, it stores neither.';
export const REPO_ROOT_HELP = 'The session always runs in the source’s repo root. Off, it runs in the ticket’s worktree, else the repo root.';

/** Every field with its value, in one order, for reading one by key and comparing playbooks. */
export function playbookJson(playbook: PlaybookFields): JsonObject {
  return {
    description: playbook.description,
    kind: playbook.kind,
    autoStart: playbook.autoStart,
    requiresWorktree: playbook.requiresWorktree,
    permissionMode: playbook.permissionMode,
    model: playbook.model,
    workdir: playbook.workdir,
    reports: [...playbook.reports],
    approvalSends: playbook.approvalSends,
    rates: playbook.rates,
    returnOf: [...playbook.returnOf],
    focus: playbook.focus,
    provider: playbook.provider,
    template: playbook.template,
  };
}

/** Whether two playbooks have the same fields. */
export const samePlaybook = (a: PlaybookFields, b: PlaybookFields | null): boolean => b !== null && JSON.stringify(playbookJson(a)) === JSON.stringify(playbookJson(b));

/** The entry the page writes: defaults left out, except `autoStart` and `requiresWorktree` on a task playbook, in `PLAYBOOK_KEYS` order. */
export function playbookEntry(playbook: PlaybookFields): JsonObject {
  const task = playbook.kind === 'task';
  const entry: JsonObject = { description: playbook.description };

  if (!task) {
    entry['kind'] = playbook.kind;
  }

  if (task || playbook.autoStart) {
    entry['autoStart'] = playbook.autoStart;
  }

  if (task || playbook.requiresWorktree) {
    entry['requiresWorktree'] = playbook.requiresWorktree;
  }

  if (playbook.workdir !== 'worktree') {
    entry['workdir'] = playbook.workdir;
  }

  if (playbook.reports.length > 0) {
    entry['reports'] = [...playbook.reports];
  }

  if (playbook.approvalSends) {
    entry['approvalSends'] = true;
  }

  if (playbook.returnOf.length > 0) {
    entry['returnOf'] = [...playbook.returnOf];
  }

  if (playbook.focus !== null) {
    entry['focus'] = playbook.focus;
  }

  if (playbook.rates) {
    entry['rates'] = true;
  }

  if (playbook.provider !== null) {
    entry['provider'] = playbook.provider;
  }

  if (playbook.permissionMode !== null) {
    entry['permissionMode'] = playbook.permissionMode;
  }

  if (playbook.model !== null) {
    entry['model'] = playbook.model;
  }

  entry['template'] = playbook.template;
  return entry;
}

/** A playbook with one field changed from its input. */
export function applyPlaybookField(playbook: PlaybookFields, key: string, input: string, checked = false): PlaybookFields {
  if (key.startsWith('reports.') && REPORT_KINDS.includes(key.slice('reports.'.length))) {
    const kind = key.slice('reports.'.length);
    const listed = [...playbook.reports.filter((report) => report !== kind), ...(checked ? [kind] : [])];
    const reports = REPORT_KINDS.filter((report) => listed.includes(report));

    // The hub accepts approvalSends only beside the approval report, so the draft drops it with the report.
    return { ...playbook, reports, approvalSends: playbook.approvalSends && reports.includes('approval') };
  }

  const orNull = (text: string): string | null => (text === '' ? null : text);

  switch (key) {
    case 'autoStart':
      return { ...playbook, autoStart: checked };
    case 'requiresWorktree':
      return { ...playbook, requiresWorktree: checked };
    case 'approvalSends':
      return { ...playbook, approvalSends: checked };
    case 'rates':
      return { ...playbook, rates: checked };
    case 'provider':
      return { ...playbook, provider: orNull(input) };
    case 'focus':
      return { ...playbook, focus: orNull(input) };
    case 'permissionMode':
      return { ...playbook, permissionMode: orNull(input) };
    case 'model':
      return { ...playbook, model: orNull(input) };
    case 'returnOf':
      return { ...playbook, returnOf: [...new Set(input.split(/[\n,]/).map((line) => line.trim()).filter((line) => line !== ''))] };
    case 'kind':
      // The hub accepts reports only on a task playbook and rates only on a triage one, so the draft drops the other kind's keys.
      return input === 'triage' ? { ...playbook, kind: 'triage', reports: [], approvalSends: false, returnOf: [], focus: null } : { ...playbook, kind: 'task', rates: false };
    case 'workdir':
      return { ...playbook, workdir: input === 'repoRoot' ? 'repoRoot' : 'worktree' };
    case 'description':
      return { ...playbook, description: input };
    case 'template':
      return { ...playbook, template: input };
    default:
      return playbook;
  }
}

/** A column of a namespace's playbook table: a playbook field path, its header and tooltip, and the header it sits under. */
export interface TableColumn {
  path: string;
  label: string;
  help: string;
  group: string | null;
}

export interface TableCell {
  checked: boolean;
  enabled: boolean;
}

/** The checkbox columns of a namespace's playbook table: the task columns when it has a task playbook, Rates when it has a triage one. */
export function tableColumns(playbooks: readonly PlaybookFields[]): TableColumn[] {
  const kinds = new Set(playbooks.map((playbook) => playbook.kind));
  const columns: TableColumn[] = [];

  if (kinds.has('task')) {
    columns.push({ path: 'autoStart', label: 'Auto', help: AUTO_START_HELP, group: 'Start' });
    columns.push({ path: 'requiresWorktree', label: 'Needs worktree', help: REQUIRES_WORKTREE_HELP, group: 'Start' });

    for (const report of REPORT_FIELDS) {
      columns.push({ path: `reports.${report.kind}`, label: report.label, help: report.help, group: 'Reports' });

      if (report.kind === 'approval') {
        columns.push({ path: 'approvalSends', label: 'Sends', help: APPROVAL_SENDS_HELP, group: 'Reports' });
      }
    }

    columns.push({ path: 'workdir', label: 'Repo root', help: REPO_ROOT_HELP, group: null });
  }

  if (kinds.has('triage')) {
    columns.push({ path: 'rates', label: 'Rates', help: RATES_HELP, group: null });
  }

  return columns;
}

/** A playbook field's value; a `reports.<kind>` field is whether the playbook lists that report. */
export function playbookFieldValue(playbook: PlaybookFields, path: string): Json | undefined {
  return path.startsWith('reports.') ? playbook.reports.includes(path.slice('reports.'.length)) : playbookJson(playbook)[path];
}

/** A playbook's checkbox in a table column, or null when the column does not apply to its kind. Sends is enabled only with Approval. */
export function tableCell(playbook: PlaybookFields, path: string): TableCell | null {
  if (path === 'rates') {
    return playbook.kind === 'triage' ? { checked: playbook.rates, enabled: true } : null;
  }

  if (playbook.kind === 'triage') {
    return null;
  }

  if (path === 'workdir') {
    return { checked: playbook.workdir === 'repoRoot', enabled: true };
  }

  if (path === 'approvalSends') {
    return { checked: playbook.approvalSends, enabled: playbook.reports.includes('approval') };
  }

  return { checked: playbookFieldValue(playbook, path) === true, enabled: true };
}

/** A playbook with a table checkbox changed; Repo root sets the working directory. */
export const applyPlaybookCell = (playbook: PlaybookFields, path: string, checked: boolean): PlaybookFields =>
  path === 'workdir' ? applyPlaybookField(playbook, 'workdir', checked ? 'repoRoot' : 'worktree') : applyPlaybookField(playbook, path, '', checked);

/** The field a playbook error names: the key it starts with, or the template. */
export function playbookFieldOfError(error: string, paths: readonly string[]): string | null {
  return paths.find((path) => error.startsWith(`${path} `)) ?? (error.toLowerCase().includes('template') ? 'template' : null);
}

/** The keys of a playbook entry, which the hub accepts and the page has fields for, in the order it writes them. */
export const PLAYBOOK_KEYS = ['description', 'kind', 'autoStart', 'requiresWorktree', 'workdir', 'reports', 'approvalSends', 'returnOf', 'focus', 'rates', 'provider', 'permissionMode', 'model', 'template'];

/**
 * An entry's fields, or null and why it cannot be read: it is not an object, has a key the hub does not know, or a key has the wrong JSON type.
 * Absent and null keys take their defaults.
 */
export function readPlaybook(node: Json | undefined): { fields: PlaybookFields | null; error: string | null } {
  if (!isObject(node)) {
    return { fields: null, error: 'A playbook must be an object.' };
  }

  const unknown = Object.keys(node).filter((key) => !PLAYBOOK_KEYS.includes(key));

  if (unknown.length > 0) {
    return { fields: null, error: `Unknown keys: ${unknown.join(', ')}.` };
  }

  let error: string | null = null;
  const textOf = (key: string): string | null => {
    const value = node[key];

    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value === 'string') {
      return value;
    }

    error ??= `${key} must be a string.`;
    return null;
  };
  const flag = (key: string): boolean => {
    const value = node[key];

    if (value === undefined || value === null) {
      return false;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    error ??= `${key} must be true or false.`;
    return false;
  };
  const list = (key: string): string[] => {
    const value = node[key];

    if (value === undefined || value === null) {
      return [];
    }

    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      return value as string[];
    }

    error ??= `${key} must be a list of strings.`;
    return [];
  };
  const fields: PlaybookFields = {
    description: textOf('description') ?? '',
    kind: textOf('kind') ?? 'task',
    autoStart: flag('autoStart'),
    requiresWorktree: flag('requiresWorktree'),
    permissionMode: textOf('permissionMode'),
    model: textOf('model'),
    workdir: textOf('workdir') ?? 'worktree',
    reports: list('reports'),
    approvalSends: flag('approvalSends'),
    rates: flag('rates'),
    returnOf: list('returnOf'),
    template: textOf('template') ?? '',
    provider: textOf('provider'),
    focus: textOf('focus'),
  };

  return error === null ? { fields, error: null } : { fields: null, error };
}

/** A playbook page's fields; what shows depends on its kind, its reports and its agent. */
export function playbookFields(state: EditorState, playbook: PlaybookFields): Field[] {
  const setting = (path: string): string | null => {
    const value = getAt(state.value ?? undefined, path);

    return typeof value === 'string' && value !== '' ? value : null;
  };
  const defaultProvider = setting('sessions.provider') ?? 'claude';
  const codex = (playbook.provider ?? defaultProvider) === 'codex';
  const mode = setting(codex ? 'sessions.codex.permissionMode' : 'sessions.permissionMode') ?? (codex ? 'bypassPermissions' : 'auto');
  const model = setting(codex ? 'sessions.codex.model' : 'sessions.model');
  const modes = codex ? state.config.codexPermissionModes : state.config.permissionModes;
  const fields: Field[] = [
    { path: 'description', label: 'Description', kind: 'text', help: 'Tells triage when to choose this playbook. One line.' },
    {
      path: 'kind',
      label: 'Kind',
      kind: 'select',
      help: 'A triage playbook holds a source’s classifier instructions and is never chosen for work.',
      options: [
        { value: 'task', label: 'task' },
        { value: 'triage', label: 'triage' },
      ],
    },
  ];

  if (playbook.kind === 'triage') {
    fields.push({ path: 'rates', label: 'Rates importance', kind: 'boolean', help: RATES_HELP });
  }

  if (playbook.kind === 'task') {
    fields.push({ path: 'autoStart', label: 'Automatically', kind: 'boolean', help: AUTO_START_HELP, group: 'Start' });
    fields.push({ path: 'requiresWorktree', label: 'Needs a worktree', kind: 'boolean', help: REQUIRES_WORKTREE_HELP, group: 'Start' });
    fields.push(...REPORT_FIELDS.map((report): Field => ({ path: `reports.${report.kind}`, label: report.label, kind: 'boolean', help: report.help, group: 'Reports' })));

    if (playbook.reports.includes('approval')) {
      fields.push({ path: 'approvalSends', label: 'Approve sends the work', kind: 'boolean', help: APPROVAL_SENDS_HELP });
    }

    fields.push({
      path: 'workdir',
      label: 'Working directory',
      kind: 'select',
      help: '',
      options: [
        { value: 'worktree', label: 'The ticket’s worktree, else the repo root' },
        { value: 'repoRoot', label: 'Always the source’s repo root' },
      ],
    });
    fields.push({
      path: 'provider',
      label: 'Agent',
      kind: 'select',
      help: 'The agent this playbook’s sessions run in.',
      options: withCurrent([{ value: '', label: `Sessions setting (${providerName(defaultProvider)})` }, ...state.config.providers.map((entry) => ({ value: entry, label: providerName(entry) }))], playbook.provider ?? undefined),
    });
    fields.push({
      path: 'permissionMode',
      label: 'Permission mode',
      kind: 'select',
      help: codex ? 'Commands in Codex’s sandbox cannot use your sign-ins, such as gh’s.' : '',
      options: withCurrent([{ value: '', label: `Sessions setting (${mode})` }, ...modes.map((entry) => ({ value: entry, label: entry }))], playbook.permissionMode ?? undefined),
    });
    fields.push({ path: 'model', label: 'Model', kind: 'text', help: '', placeholder: `Sessions setting (${model ?? (codex ? 'Codex’s default' : 'Claude’s default')})` });
    fields.push({ path: 'returnOf', label: 'Return of', kind: 'list', help: RETURN_OF_HELP });
    fields.push({
      path: 'focus',
      label: 'Focus page',
      kind: 'select',
      help: FOCUS_HELP,
      options: withCurrent(
        [
          { value: '', label: 'Any page' },
          { value: 'ticket', label: 'The ticket' },
          { value: 'pr', label: 'The pull request' },
        ],
        playbook.focus ?? undefined,
      ),
    });
  }

  fields.push({
    path: 'template',
    label: playbook.kind === 'triage' ? 'Classifier instructions' : 'Prompt',
    kind: 'prompt',
    help:
      playbook.kind === 'triage'
        ? 'The classifier’s system prompt. {{playbooks}} inserts the task playbooks as “- name: description” lines; without it, triage appends them.'
        : `Variables: ${state.config.templateVariables.map((name) => `{{${name}}}`).join(' ')}. Switchboard adds the commands for the checked reports, with stage and link.`,
  });

  return fields;
}

export function generalFields(state: EditorState): Section[] {
  const modes = state.config.permissionModes.map((mode) => ({ value: mode, label: mode }));
  const codexModes = state.config.codexPermissionModes.map((mode) => ({ value: mode, label: mode }));
  const providers = state.config.providers.map((provider) => ({ value: provider, label: providerName(provider) }));

  return [
    {
      heading: 'Sessions',
      fields: [
        { path: 'sessions.provider', label: 'Default agent', kind: 'select', help: 'The agent playbook and ad-hoc sessions run in. A playbook can name its own.', placeholder: 'claude', options: providers },
        { path: 'sessions.concurrency', label: 'Concurrency', kind: 'integer', help: 'Sessions that run at once, 1 to 10. A start with no free slot waits as queued.', placeholder: '2' },
        {
          path: 'sessions.codeMode',
          label: 'Code Mode (experimental)',
          kind: 'boolean',
          help: 'New Claude sessions run with Claude Code’s Code Mode, held by Switchboard’s terminal holder, and open in a terminal instead of the Claude view. They keep running between turns until you stop them or they sit idle for an hour. They skip the gateway in your Claude settings and use your Claude subscription sign-in. Sessions already started keep their mode. Needs Install hooks.',
          fallback: false,
        },
        { path: 'sessions.debriefs', label: 'Friction debriefs', kind: 'boolean', help: 'Ask each session what slowed it down, once its work item is done or 45 minutes after its last turn. The answers go to ~/.claude/.wip/debrief for the friction-review skill.', fallback: false },
      ],
    },
    {
      heading: 'Claude sessions',
      fields: [
        { path: 'sessions.model', label: 'Model', kind: 'text', help: 'A playbook can set its own.', placeholder: "Claude's default" },
        { path: 'sessions.permissionMode', label: 'Permission mode', kind: 'select', help: 'A playbook can set its own.', placeholder: 'auto', options: modes },
      ],
    },
    {
      heading: 'Codex sessions',
      fields: [
        { path: 'sessions.codex.model', label: 'Model', kind: 'text', help: 'A playbook can set its own.', placeholder: "Codex's default" },
        { path: 'sessions.codex.permissionMode', label: 'Permission mode', kind: 'select', help: 'A playbook can set its own. Commands in Codex’s sandbox cannot use your sign-ins, such as gh’s, so skills that call them need bypassPermissions.', placeholder: 'bypassPermissions', options: codexModes },
      ],
    },
    {
      heading: 'Triage',
      fields: [
        { path: 'triage.concurrency', label: 'Concurrency', kind: 'integer', help: 'Triages that run at once.', placeholder: '2' },
        { path: 'triage.model', label: 'Model', kind: 'text', help: 'Triage uses the default agent. A model from the other agent falls back to its default.', placeholder: "Agent's default" },
        { path: 'triage.timeoutSeconds', label: 'Timeout (seconds)', kind: 'integer', help: '', placeholder: '180' },
      ],
    },
    {
      heading: 'Dock',
      fields: [
        {
          path: 'dock.openVSCode',
          label: 'Rows open in',
          kind: 'select',
          help: 'Where a row opens its work. Only for review opens the session in a terminal, Ptyxis on Linux or Windows Terminal on Windows, until its work awaits approval or is finished, so fewer VS Code windows stay open.',
          placeholder: 'always',
          options: [
            { value: 'always', label: 'Always' },
            { value: 'review', label: 'Only for review' },
          ],
        },
        {
          path: 'dock.openTerminal',
          label: 'Terminal for "Open in terminal"',
          kind: 'select',
          help: "Where Open in terminal runs when Rows open in is Always. VS Code when open brings forward the session's terminal app window when there is one, else uses the item window's terminal while that window is open, else the terminal app: Ptyxis on Linux, Windows Terminal on Windows. On Linux without Switchboard's GNOME Shell extension it uses the item window. Only for review always uses the terminal app.",
          placeholder: 'vscode',
          options: [
            { value: 'vscode', label: 'VS Code' },
            { value: 'app', label: 'Terminal app' },
            { value: 'auto', label: 'VS Code when open' },
          ],
        },
      ],
    },
    {
      heading: 'Web page',
      fields: [
        {
          path: 'web.chromePane',
          label: 'Chrome pane (experimental)',
          kind: 'boolean',
          help: "Experimental, Windows only, and may break with Chrome updates. Shows the selected work item's ticket and pull request in a Chrome window that the dock keeps over the installed web page's right column. Needs the Switchboard Chrome extension, paired from the page's view options.",
          fallback: false,
        },
      ],
    },
    {
      heading: 'Advanced',
      advanced: true,
      fields: [
        { path: 'sessions.installHooks', label: 'Install hooks', kind: 'boolean', help: 'Add Switchboard’s hooks to your Claude and Codex settings, so the dock shows when a session waits for you or runs in VS Code. Off, the session list and Codex’s run output alone decide state.', fallback: true },
        { path: 'sessions.claudePath', label: 'Claude Code path', kind: 'text', help: 'The Claude Code CLI the hub and Open in terminal run. Set its full path when their PATH does not include it.', placeholder: 'claude' },
        { path: 'sessions.codexPath', label: 'Codex path', kind: 'text', help: 'The Codex CLI the hub and Open in terminal run. Set its full path when their PATH does not include it, such as a Codex installed through nvm.', placeholder: 'codex' },
        { path: 'sessions.nodePath', label: 'Node.js path', kind: 'text', help: 'The Node.js that Switchboard’s hooks and session reports run. Set its full path, with no spaces, when the agents’ PATH does not include it, such as a Node.js installed through nvm.', placeholder: 'node' },
      ],
    },
  ];
}

export const SOURCE_LABELS: Readonly<Record<string, string>> = { github: 'GitHub', zoho: 'Zoho Desk', forum: 'Forum' };

export const sourceLabel = (kind: string): string => SOURCE_LABELS[kind] ?? kind;

/** The settings every source has; a change of kind keeps only these, because each plugin rejects another's keys. */
export const COMMON_SOURCE_KEYS = ['kind', 'pollIntervalSeconds', 'repoRoot', 'triagePlaybook', 'setupPrompt', 'namespace'];

/** A source's `kind`, or its name when it sets none (PRD R3). */
export function sourceKind(settings: Json | undefined | null, name: string): string {
  const kind = getAt(settings ?? undefined, `sources.${name}.kind`);

  return typeof kind === 'string' && kind !== '' ? kind : name;
}

/** A source's title: its kind's label, such as GitHub, or for a source named apart from its kind, the name and that label. */
export function sourceTitle(state: EditorState, name: string): string {
  const kind = sourceKind(state.value, name);

  return kind === name ? sourceLabel(name) : `${name} (${sourceLabel(kind)})`;
}

type OptionField = { key: string; field: Omit<Field, 'path'>; advanced: boolean };

const OPTION_FIELDS: Readonly<Record<string, readonly OptionField[]>> = {
  github: [
    { key: 'repo', field: { label: 'Repository', kind: 'text', help: '', placeholder: 'owner/name' }, advanced: false },
    { key: 'logins', field: { label: 'Logins', kind: 'list', help: 'One per line. Your GitHub logins: comments and commits by them are yours, and with Require assignee on, an issue assigned to any of them is yours.' }, advanced: false },
    { key: 'requireAssignee', field: { label: 'Require assignee', kind: 'boolean', help: 'Off, an issue in an assigned status is yours whoever is assigned.', fallback: true }, advanced: false },
    { key: 'waitForBlockers', field: { label: 'Wait for blockers', kind: 'boolean', help: "On, an issue's work starts only once the issues blocking it close. Leave off to start stacked work from a blocker's branch.", fallback: false }, advanced: false },
    { key: 'includeClosed', field: { label: 'Include closed issues', kind: 'boolean', help: 'On, a closed issue in an assigned status is still yours, for a team that closes issues before they merge.', fallback: false }, advanced: false },
    { key: 'project.owner', field: { label: 'Project owner', kind: 'text', help: '' }, advanced: false },
    { key: 'project.number', field: { label: 'Project number', kind: 'integer', help: '' }, advanced: false },
    { key: 'project.statusField', field: { label: 'Status field', kind: 'text', help: '', placeholder: 'Status' }, advanced: false },
    { key: 'assignedStatuses', field: { label: 'Assigned statuses', kind: 'list', help: 'One per line. An issue in one of these project statuses is yours. Empty, an issue in any status, or none, is yours.' }, advanced: false },
    { key: 'rolesFile', field: { label: 'Roles file', kind: 'text', help: 'A JSON file of {"login": {"roles": ["tester"]}}. Triage shows each comment author\'s roles. Starts with ~ or is absolute.' }, advanced: true },
    { key: 'branchPattern', field: { label: 'Branch pattern', kind: 'text', help: 'A regular expression whose first group is the issue number a worktree branch names.', placeholder: '^(\\d+)-' }, advanced: true },
    { key: 'ghPath', field: { label: 'gh path', kind: 'text', help: '', placeholder: 'gh' }, advanced: true },
    { key: 'maxPages', field: { label: 'Page limit', kind: 'integer', help: 'A poll that needs more pages of 100 issues fails.', placeholder: '5' }, advanced: true },
  ],
  zoho: [
    { key: 'orgId', field: { label: 'Organization ID', kind: 'text', help: '' }, advanced: false },
    { key: 'agentId', field: { label: 'Agent ID', kind: 'text', help: 'Your Zoho agent ID.' }, advanced: false },
    { key: 'escalationField', field: { label: 'Escalation field', kind: 'text', help: 'The custom field that holds the escalation tier.', placeholder: 'cf_queue' }, advanced: true },
    { key: 'escalationValue', field: { label: 'Escalation value', kind: 'text', help: 'The escalation tier that puts a ticket in scope.', placeholder: 'Support' }, advanced: true },
    { key: 'automationAgentIds', field: { label: 'Automation agent IDs', kind: 'list', help: 'One per line. Agents whose hold on a ticket is not a claim. Empty means none.', listDefault: ['8000000000000000002', '8000000000000000003'] }, advanced: true },
    { key: 'tokenCommand', field: { label: 'Token command', kind: 'text', help: 'Prints a Desk access token. Runs in Git Bash.', placeholder: 'bash ~/.claude/scripts/desk-token.sh' }, advanced: true },
    { key: 'apiBase', field: { label: 'API base', kind: 'text', help: '', placeholder: 'https://desk.zoho.com/api/v1' }, advanced: true },
    { key: 'maxPages', field: { label: 'Page limit', kind: 'integer', help: 'A poll that needs more pages fails.', placeholder: '20' }, advanced: true },
  ],
  forum: [
    { key: 'userId', field: { label: 'User ID', kind: 'text', help: 'Your forum user ID.' }, advanced: false },
    { key: 'forumId', field: { label: 'Forum ID', kind: 'integer', help: '', placeholder: '11' }, advanced: true },
    { key: 'queryCommand', field: { label: 'Query command', kind: 'text', help: 'Runs SQL from stdin against the forum database. Runs in Git Bash.', placeholder: 'bash ~/.claude/scripts/run-forum-sql.sh' }, advanced: true },
    { key: 'maxRows', field: { label: 'Row limit', kind: 'integer', help: 'A poll that returns this many open topics is incomplete.', placeholder: '500' }, advanced: true },
    { key: 'auditDatabase', field: { label: 'Audit database', kind: 'text', help: 'The change-history database on the same host.', placeholder: 'audit' }, advanced: true },
  ],
};

export function sourceFields(state: EditorState, name: string): Section[] {
  const path = `sources.${name}`;
  const value = state.value ?? undefined;
  const triage = state.playbookNames.filter((entry) => state.playbookValue(entry)?.kind === 'triage').map((entry) => ({ value: entry, label: entry }));
  const common: Field[] = [
    { path: `${path}.pollIntervalSeconds`, label: 'Poll interval (seconds)', kind: 'integer', help: 'At least 10.', placeholder: '300' },
    { path: `${path}.repoRoot`, label: 'Repo root', kind: 'text', help: 'The repository sessions run in when the ticket has no worktree.' },
    {
      path: `${path}.namespace`,
      label: 'Namespace',
      kind: 'select',
      help: 'Triage chooses among this namespace’s task playbooks.',
      options: withCurrent([{ value: '', label: 'Every namespace' }, ...state.namespaces.map((entry) => ({ value: entry, label: entry }))], getAt(value, `${path}.namespace`)),
    },
    { path: `${path}.triagePlaybook`, label: 'Triage playbook', kind: 'select', help: '', options: withCurrent([{ value: '', label: 'None' }, ...triage], getAt(value, `${path}.triagePlaybook`)) },
    { path: `${path}.setupPrompt`, label: 'Setup prompt', kind: 'prompt', help: 'Runs before a playbook that requires a worktree, when the ticket has none.' },
  ];

  // adhoc holds only the ad-hoc repo root, so it has no plugin to choose.
  if (name !== 'adhoc') {
    common.unshift({
      path: `${path}.kind`,
      label: 'Kind',
      kind: 'select',
      help: "The plugin that reads the source. Changing it drops the old plugin's settings.",
      options: withCurrent([{ value: '', label: `Same as the name (${name})` }, ...state.config.sourceKinds.map((entry) => ({ value: entry, label: sourceLabel(entry) }))], getAt(value, `${path}.kind`)),
    });
  }

  const kind = sourceKind(value, name);
  const options = (OPTION_FIELDS[kind] ?? []).map((entry) => ({ field: { ...entry.field, path: `${path}.${entry.key}` } as Field, advanced: entry.advanced }));
  const sections: Section[] = [{ heading: 'Source', fields: common }];
  const plain = options.filter((entry) => !entry.advanced).map((entry) => entry.field);
  const advanced = options.filter((entry) => entry.advanced).map((entry) => entry.field);

  if (plain.length > 0) {
    sections.push({ heading: sourceLabel(kind), fields: plain });
  }

  if (advanced.length > 0) {
    sections.push({ heading: 'Advanced', fields: advanced, advanced: true });
  }

  return sections;
}

/** The sections of a settings page, by its name; none for a page this file does not know. */
export function pageSections(state: EditorState, page: string): Section[] {
  if (page === 'general') {
    return generalFields(state);
  }

  if (page.startsWith('source:')) {
    return sourceFields(state, page.slice('source:'.length));
  }

  return [];
}

/** The settings pages the navigation offers, each of which owns the errors that name its fields. */
export function settingsPages(state: EditorState): string[] {
  return ['general', ...state.sourceNames.map((name) => `source:${name}`)];
}

/** Every settings field path, with the page that shows it. */
export function settingsPaths(state: EditorState): Array<{ path: string; page: string }> {
  return settingsPages(state).flatMap((page) => pageSections(state, page).flatMap((section) => section.fields.map((field) => ({ path: field.path, page }))));
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The field an error names, by the longest path it contains. Under `sources` and `schedules`, a parent path such as `sources.github` names its first field. */
export function fieldOfError(error: string, paths: readonly string[]): string | null {
  // The path stands alone: not part of a longer path, though a sentence's final period may follow it.
  const names = (path: string): boolean => new RegExp(`(^|[^\\w.])${escapeRegExp(path)}($|[^\\w.]|\\.(\\s|$))`).test(error);
  let best: { path: string; length: number } | null = null;

  for (const path of paths) {
    const parts = path.split('.');
    const shortest = parts[0] === 'sources' || parts[0] === 'schedules' ? 2 : parts.length;

    for (let length = parts.length; length >= shortest; length--) {
      if (names(parts.slice(0, length).join('.')) && (best === null || length > best.length)) {
        best = { path, length };
      }
    }
  }

  return best?.path ?? null;
}

/** The page that holds each error's field; an error with no field, or whose page the navigation does not offer, maps to null and shows on every page. */
export function errorPages(state: EditorState): Map<string, string | null> {
  const entries = settingsPaths(state);
  const paths = entries.map((entry) => entry.path);
  const pages = new Map<string, string | null>();

  for (const error of state.settingsErrors) {
    const path = fieldOfError(error, paths);

    pages.set(error, path === null ? null : (entries.find((entry) => entry.path === path)?.page ?? null));
  }

  return pages;
}

/** The parts of settings.json a page edits, by which the navigation marks it unsaved. */
export function pagePaths(page: string): string[] {
  return page === 'general' ? ['sessions', 'triage', 'dock', 'web'] : page.startsWith('source:') ? [`sources.${page.slice('source:'.length)}`] : [];
}

export function pageDirty(state: EditorState, page: string): boolean {
  if (page.startsWith('namespace:')) {
    return state.namespacePlaybooks(page.slice('namespace:'.length)).some((name) => state.playbookDirty(name));
  }

  if (page.startsWith('playbook:')) {
    return state.playbookDirty(page.slice('playbook:'.length));
  }

  // Text typed on a New page before Create is not a change to the file.
  return state.draft !== null && pagePaths(page).some((path) => json(getAt(state.draft!, path)) !== json(getAt(state.config.settings.value, path)));
}

export function pageHasErrors(state: EditorState, page: string): boolean {
  if (page.startsWith('namespace:')) {
    return state.namespacePlaybooks(page.slice('namespace:'.length)).some((name) => pageHasErrors(state, `playbook:${name}`));
  }

  if (page.startsWith('playbook:')) {
    const name = page.slice('playbook:'.length);

    return state.playbookErrors(name).length > 0 || (state.hasPlaybook(name) && state.playbookValue(name) === null);
  }

  return [...errorPages(state).values()].includes(page);
}

/** A navigation entry: a heading, a page, or an Add entry. */
export interface NavEntry {
  kind: 'heading' | 'item' | 'add' | 'namespace';
  label: string;
  page?: string;
  /** For an Add entry that adds rather than opens a page: the source kind New <kind> source adds. */
  addSource?: string;
  note?: string;
  current: boolean;
  dirty: boolean;
  errors: boolean;
}

const heading = (label: string): NavEntry => ({ kind: 'heading', label, current: false, dirty: false, errors: false });

const add = (state: EditorState, label: string, page: string): NavEntry => ({ kind: 'add', label, page, current: state.page === page, dirty: false, errors: false });

/** The navigation, in the order a ticket takes: its source, its playbook, the schedules that start playbooks, then voice, an optional feature. */
export function nav(state: EditorState): NavEntry[] {
  const sources = state.sourceNames;
  const entries: NavEntry[] = [item(state, 'general', 'General'), heading('Sources')];

  for (const name of sources) {
    entries.push(item(state, `source:${name}`, sourceTitle(state, name), state.config.enabled[name] === true ? undefined : 'off'));
  }

  for (const kind of state.config.sourceKinds.filter((entry) => !sources.includes(entry))) {
    entries.push({ kind: 'add', label: `New ${sourceLabel(kind)} source`, addSource: kind, current: false, dirty: false, errors: false });
  }

  entries.push(add(state, 'New source', 'new-source'));
  entries.push(heading('Playbooks'));

  for (const space of state.namespaces) {
    const page = `namespace:${space}`;

    entries.push({ kind: 'namespace', label: space, page, current: state.page === page, dirty: pageDirty(state, page), errors: pageHasErrors(state, page) });

    for (const name of state.namespacePlaybooks(space)) {
      entries.push(item(state, `playbook:${name}`, name.includes(':') ? name.slice(name.indexOf(':') + 1) : name));
    }
  }

  entries.push(add(state, 'New playbook', 'new-playbook'));
  return entries;
}

function item(state: EditorState, page: string, label: string, note?: string): NavEntry {
  return { kind: 'item', label, page, ...(note === undefined ? {} : { note }), current: state.page === page, dirty: pageDirty(state, page), errors: pageHasErrors(state, page) };
}

/** The bar: the file's status, a warning that settings.json changed on disk, the errors of a refused or blocked save, and whether Save and Discard are enabled. */
export interface BarView {
  status: string;
  warning: string | null;
  errors: readonly string[];
  canSave: boolean;
  canDiscard: boolean;
}

export function bar(state: EditorState): BarView {
  const count = state.errors.length;
  const status = state.saving
    ? 'Saving…'
    : state.value === null
      ? 'settings.json cannot be read'
      : [state.dirty ? 'Unsaved changes' : 'Saved', ...(count === 0 ? [] : [count === 1 ? '1 error' : `${count} errors`])].join(' · ');
  const warning = state.changedOnDisk ? 'settings.json changed on disk, so your changes cannot be saved. Discard them and open Settings again to load it.' : null;

  return { status, warning, errors: state.barErrors, canSave: state.dirty && !state.changedOnDisk && !state.saving, canDiscard: (state.dirty || state.changedOnDisk) && !state.saving };
}

/** A field with what it shows: its text or checked state, the option chosen, and the errors that name it. */
export interface FieldView {
  field: Field;
  text: string;
  checked: boolean;
  selected: string;
  errors: string[];
}

export interface SectionView {
  heading: string;
  advanced: boolean;
  fields: FieldView[];
}

/** A header button. */
export interface PageButton {
  command: string;
  label: string;
  primary?: boolean;
  argument?: string;
  tip?: string;
}

/** One page: its title, the file it edits, its buttons, notes, the errors that name no field, a message in place of fields, and the sections. */
/** A New page's name fields and the name's error, shown once a name is typed or Create was pressed; a source's has a kind of `kinds` too. */
export interface NewNameView {
  label: string;
  help: string;
  placeholder: string;
  name: string;
  error: string | null;
  kinds?: readonly FieldOption[];
  kind?: string;
  /** The New playbook page's namespace, and the namespaces to offer. */
  namespace?: string;
  namespaces?: readonly string[];
}

/** A namespace's playbooks, one row each, with a checkbox per column; a null cell does not apply to the row's kind or unreadable entry. */
export interface PlaybookTable {
  columns: TableColumn[];
  rows: Array<{ name: string; label: string; description: string; cells: Array<TableCell | null>; dirty: boolean; errors: string[] }>;
}

export interface PageView {
  newName?: NewNameView;
  table?: PlaybookTable;
  title: string;
  filePath: string | null;
  buttons: PageButton[];
  notes: string[];
  errors: string[];
  message: string | null;
  sections: SectionView[];
}

const FIX_BY_HAND = 'Fix the file in an editor; the page reads it again when it changes.';

export function pageView(state: EditorState): PageView {
  const page = state.page;

  if (page.startsWith('source:')) {
    const name = page.slice('source:'.length);
    const kind = sourceKind(state.value, name);
    const notes = state.config.sourceKinds.includes(kind) ? [] : [`Switchboard has no source kind ${kind}.`];

    return settingsPage(state, sourceTitle(state, name), sourceFields(state, name), [{ command: 'remove-source', label: 'Remove source', argument: name }], notes);
  }

  if (page === 'new-source') {
    const { name, touched } = state.newSource;

    return {
      title: 'New source',
      filePath: null,
      buttons: [{ command: 'create', label: 'Create', primary: true }],
      notes: [],
      errors: [],
      message: null,
      sections: [],
      newName: {
        label: 'Name',
        help: "Lowercase letters, digits and hyphens. It names the source's tickets, such as widgets-dashboard 63. Create adds the source to settings.json when you save.",
        placeholder: 'widgets-dashboard',
        name,
        error: name === '' && !touched ? null : state.newSourceError,
        kinds: state.config.sourceKinds.map((kind) => ({ value: kind, label: sourceLabel(kind) })),
        kind: state.newSourceKind,
      },
    };
  }

  if (page.startsWith('namespace:')) {
    return namespacePage(state, page.slice('namespace:'.length));
  }

  if (page === 'new-playbook') {
    const draft = state.newPlaybook;
    const { loose, sections } = playbookSections(state, draft.playbook, []);

    return {
      title: 'New playbook',
      filePath: null,
      buttons: [{ command: 'create', label: 'Create', primary: true }],
      notes: [],
      errors: loose,
      message: null,
      sections,
      newName: {
        label: 'Name',
        help: 'Lowercase letters, digits and hyphens. Create adds the playbook to settings.json when you save.',
        placeholder: 'develop',
        name: draft.name,
        namespace: draft.namespace,
        namespaces: state.namespaces,
        error: draft.namespace === '' && draft.name === '' && !draft.touched ? null : state.newNameError,
      },
    };
  }

  if (page.startsWith('playbook:')) {
    const name = page.slice('playbook:'.length);
    const path = state.config.settings.path;
    const blank = { notes: [], sections: [] };

    if (!state.hasPlaybook(name)) {
      return { title: name, filePath: path, buttons: [], errors: [], message: 'This playbook no longer exists.', ...blank };
    }

    const buttons: PageButton[] = [{ command: 'delete', label: 'Delete' }];
    const errors = state.playbookErrors(name);
    const read = readPlaybook(state.playbookEntry(name));

    if (read.fields === null) {
      return { title: name, filePath: path, buttons, errors: errors.length > 0 ? errors : [read.error!], message: FIX_ENTRY, ...blank };
    }

    const { loose, sections } = playbookSections(state, read.fields, errors);

    return { title: name, filePath: path, buttons, notes: [], errors: loose, message: null, sections };
  }

  return settingsPage(state, 'General', generalFields(state), [], []);
}

const FIX_ENTRY = 'Fix this entry in settings.json in an editor, or delete it.';

/** The errors that name no field, and the playbook's fields with the errors that name each. */
function playbookSections(state: EditorState, playbook: PlaybookFields, errors: readonly string[]): { loose: string[]; sections: SectionView[] } {
  const fields = playbookFields(state, playbook);
  const paths = fields.map((field) => field.path);
  const loose = errors.filter((error) => playbookFieldOfError(error, paths) === null);
  const views = fields.map((field) => fieldView(field, playbookFieldValue(playbook, field.path), errors.filter((error) => playbookFieldOfError(error, paths) === field.path)));

  return { loose, sections: [{ heading: '', advanced: false, fields: views }] };
}

/** A namespace's playbooks as a table of their checkboxes, each row with its own errors. */
function namespacePage(state: EditorState, space: string): PageView {
  const names = state.namespacePlaybooks(space);
  const base = { title: `${space} playbooks`, filePath: null, buttons: [], notes: [], errors: [], sections: [] };

  if (names.length === 0) {
    return { ...base, message: 'This namespace has no playbooks.' };
  }

  const playbooks = names.map((name) => ({ name, read: readPlaybook(state.playbookEntry(name)) }));
  const columns = tableColumns(playbooks.map((entry) => entry.read.fields).filter((fields): fields is PlaybookFields => fields !== null));
  const rows = playbooks.map((entry) => {
    const errors = state.playbookErrors(entry.name);

    return {
      name: entry.name,
      label: entry.name.slice(entry.name.indexOf(':') + 1),
      description: entry.read.fields?.description ?? '',
      cells: columns.map((column) => (entry.read.fields === null ? null : tableCell(entry.read.fields, column.path))),
      dirty: state.playbookDirty(entry.name),
      errors: errors.length === 0 && entry.read.error !== null ? [entry.read.error] : errors,
    };
  });

  return { ...base, message: null, table: { columns, rows } };
}

export function settingsPage(state: EditorState, title: string, sections: readonly Section[], buttons: PageButton[], notes: string[]): PageView {
  const settings = state.config.settings;
  const value = state.value;

  if (value === null) {
    return { title, filePath: settings.path, buttons: [], notes, errors: [settings.error ?? 'settings.json must contain an object.'], message: FIX_BY_HAND, sections: [] };
  }

  const paths = settingsPaths(state).map((entry) => entry.path);
  const pages = errorPages(state);
  // Errors on no page show on every page; one that names no field but belongs to this page shows here.
  const errors = state.settingsErrors;
  const loose = errors.filter((error) => {
    const on = pages.get(error) ?? null;

    return on === null || (on === state.page && fieldOfError(error, paths) === null);
  });
  const views = sections.map((section) => ({
    heading: section.heading,
    advanced: section.advanced === true,
    fields: section.fields.map((field) => fieldView(field, getAt(value, field.path), errors.filter((error) => fieldOfError(error, paths) === field.path))),
  }));

  return { title, filePath: settings.path, buttons, notes, errors: loose, message: null, sections: views };
}

/** What a field shows for its value: an absent list with a default shows the default; a checkbox without a value shows its fallback. */
export function fieldView(field: Field, value: Json | undefined, errors: string[]): FieldView {
  const shown =
    value === undefined && field.listDefault !== undefined
      ? field.listDefault.join('\n')
      : value === undefined || value === null
        ? ''
        : Array.isArray(value)
          ? value.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n')
          : typeof value === 'string'
            ? value
            : JSON.stringify(value);
  const checked = typeof value === 'boolean' ? value : field.fallback === true;
  const selected = typeof value === 'string' ? value : (field.placeholder ?? '');

  return { field, text: shown, checked, selected, errors };
}
