import type { PlaybookFields } from '@switchboard/core';
import type { ConfigFiles } from '@switchboard/hub';
import { escape } from './render.js';

/** What the extension sends the settings editor: the files, and the choices the editor offers. */
export interface EditorConfig extends ConfigFiles {
  permissionModes: string[];
  templateVariables: string[];
  sourceKinds: string[];
}

export type FieldKind = 'text' | 'integer' | 'boolean' | 'select' | 'list' | 'prompt';

export interface Field {
  /** Dotted path from the settings root, or a playbook field name. */
  path: string;
  label: string;
  kind: FieldKind;
  help: string;
  /** The value that applies when the field is empty. */
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** A checkbox's value when the key is absent. */
  fallback?: boolean;
  /** A list whose default is not empty: an absent key shows the default, and an emptied list is saved as `[]`. */
  listDefault?: string[];
}

export type PageId = 'general' | `source:${string}` | `playbook:${string}` | 'new-playbook';

export interface PlaybookDraft {
  playbook: PlaybookFields;
  /** The file version the draft started from. */
  version: string;
}

export interface NewPlaybook {
  namespace: string;
  name: string;
  playbook: PlaybookFields;
  /** Create was pressed, so an empty name shows its error. */
  touched: boolean;
}

export interface EditorState {
  config: EditorConfig;
  page: PageId;
  /** Unsaved settings.json, and the file version it started from. */
  settingsDraft: { value: Record<string, unknown>; version: string | null } | null;
  playbookDrafts: Map<string, PlaybookDraft>;
  newPlaybook: NewPlaybook;
  settingsErrors: string[];
  /** By playbook name, or `new` for the new playbook. */
  playbookErrors: Map<string, string[]>;
  /** Why the last save, create or delete failed, by the same keys. Kept across checks and refreshes until the next edit, revert or success. */
  refusals: Map<string, string[]>;
}

export const SOURCE_LABELS: Record<string, string> = { github: 'GitHub', zoho: 'Zoho Desk', forum: 'Forum' };

const POOL_SOURCES = new Set(['zoho', 'forum']);

export const EMPTY_PLAYBOOK: PlaybookFields = {
  description: '',
  kind: 'task',
  autoStart: false,
  requiresWorktree: false,
  permissionMode: null,
  model: null,
  workdir: 'worktree',
  template: '',
};

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getAt(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (isObject(value) ? value[key] : undefined), root);
}

/** A copy of `root` with `path` set, or removed when `value` is undefined. Intermediate objects are created. */
export function setAt(root: Json, path: string, value: unknown): Json {
  const [key = '', ...rest] = path.split('.');
  const copy = { ...root };

  if (rest.length === 0) {
    if (value === undefined) {
      delete copy[key];
    } else {
      copy[key] = value;
    }
  } else {
    copy[key] = setAt(isObject(copy[key]) ? copy[key] : {}, rest.join('.'), value);
  }

  return copy;
}

/** Reads a settings field's input. An empty input removes the key, so the default applies. */
export function readField(kind: FieldKind, input: { value: string; checked?: boolean }, keepEmpty = false): unknown {
  const text = input.value;

  switch (kind) {
    case 'boolean':
      return input.checked === true;
    case 'integer':
      // Text that is not a whole number is kept, so the check names the field.
      return text.trim() === '' ? undefined : /^-?\d+$/.test(text.trim()) ? Number(text.trim()) : text;
    case 'list': {
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');

      return lines.length === 0 && !keepEmpty ? undefined : lines;
    }
    default:
      return text === '' ? undefined : text;
  }
}

/** A playbook with one field changed from its input. */
export function applyPlaybookField(playbook: PlaybookFields, key: string, input: { value: string; checked?: boolean }): PlaybookFields {
  switch (key) {
    case 'autoStart':
    case 'requiresWorktree':
      return { ...playbook, [key]: input.checked === true };
    case 'permissionMode':
      return { ...playbook, permissionMode: input.value === '' ? null : (input.value as PlaybookFields['permissionMode']) };
    case 'model':
      return { ...playbook, model: input.value === '' ? null : input.value };
    case 'kind':
      return { ...playbook, kind: input.value === 'triage' ? 'triage' : 'task' };
    case 'workdir':
      return { ...playbook, workdir: input.value === 'repoRoot' ? 'repoRoot' : 'worktree' };
    case 'description':
    case 'template':
      return { ...playbook, [key]: input.value };
    default:
      return playbook;
  }
}

export function settingsValue(state: EditorState): Json | null {
  if (state.settingsDraft !== null) {
    return state.settingsDraft.value;
  }

  const value = state.config.settings.value;

  return isObject(value) ? value : null;
}

export function settingsDirty(state: EditorState): boolean {
  return state.settingsDraft !== null && JSON.stringify(state.settingsDraft.value) !== JSON.stringify(state.config.settings.value);
}

export function playbookFile(state: EditorState, name: string) {
  return state.config.playbooks.find((entry) => entry.name === name) ?? null;
}

export function playbookValue(state: EditorState, name: string): PlaybookFields | null {
  return state.playbookDrafts.get(name)?.playbook ?? playbookFile(state, name)?.playbook ?? null;
}

/** Whether two playbooks are the same once saved: saving gives the template a final newline. */
export function samePlaybook(a: PlaybookFields, b: PlaybookFields | null): boolean {
  const saved = (playbook: PlaybookFields) => ({ ...playbook, template: playbook.template.replace(/\r\n/g, '\n').replace(/([^\n])$/, '$1\n') });

  return b !== null && JSON.stringify(saved(a)) === JSON.stringify(saved(b));
}

export function playbookDirty(state: EditorState, name: string): boolean {
  const draft = state.playbookDrafts.get(name);

  return draft !== undefined && !samePlaybook(draft.playbook, playbookFile(state, name)?.playbook ?? null);
}

/** Whether settings.json or any playbook has unsaved changes. */
export function anyDirty(state: EditorState): boolean {
  return settingsDirty(state) || [...state.playbookDrafts.keys()].some((name) => playbookDirty(state, name));
}

export function newPlaybookName(draft: NewPlaybook): string {
  return `${draft.namespace.trim()}:${draft.name.trim()}`;
}

/** Why the new playbook's name cannot be used, or null. */
export function newNameError(state: EditorState): string | null {
  const { namespace, name } = state.newPlaybook;

  if (!SEGMENT.test(namespace.trim()) || !SEGMENT.test(name.trim())) {
    return 'Namespace and name must be lowercase letters, digits and hyphens.';
  }

  return playbookFile(state, newPlaybookName(state.newPlaybook)) === null ? null : `A playbook named ${newPlaybookName(state.newPlaybook)} already exists.`;
}

function namespaces(state: EditorState): string[] {
  return [...new Set(state.config.playbooks.map((entry) => entry.name.split(':')[0] ?? ''))].sort();
}

/** The choices for a select, keeping a configured value that is not among them. */
function withCurrent(options: { value: string; label: string }[], current: unknown): { value: string; label: string }[] {
  return typeof current === 'string' && current !== '' && !options.some((option) => option.value === current) ? [...options, { value: current, label: `${current} (missing)` }] : options;
}

export function generalFields(state: EditorState): { heading: string; fields: Field[] }[] {
  const modes = state.config.permissionModes.map((mode) => ({ value: mode, label: mode }));

  return [
    {
      heading: 'Sessions',
      fields: [
        { path: 'sessions.concurrency', label: 'Concurrency', kind: 'integer', placeholder: '2', help: 'Sessions that run at once, 1 to 4. A start with no free slot waits as queued.' },
        { path: 'sessions.permissionMode', label: 'Permission mode', kind: 'select', options: modes, placeholder: 'auto', help: 'Claude Code permission mode for sessions. A playbook can set its own.' },
        { path: 'sessions.model', label: 'Model', kind: 'text', placeholder: "Claude's default", help: 'The model for sessions. A playbook can set its own.' },
        {
          path: 'sessions.installHooks',
          label: 'Install hooks',
          kind: 'boolean',
          fallback: true,
          help: 'Add Switchboard’s hooks to your Claude settings, so the panel shows when a session waits for you. Off, the session list alone decides state.',
        },
      ],
    },
    {
      heading: 'Triage',
      fields: [
        { path: 'triage.model', label: 'Model', kind: 'text', placeholder: "Claude's default", help: 'The model that triages work items and pool tickets.' },
        { path: 'triage.concurrency', label: 'Concurrency', kind: 'integer', placeholder: '2', help: 'Triages that run at once.' },
        { path: 'triage.timeoutSeconds', label: 'Timeout (seconds)', kind: 'integer', placeholder: '180', help: 'A triage that runs longer fails.' },
      ],
    },
  ];
}

const OPTION_FIELDS: Record<string, (Omit<Field, 'path'> & { key: string })[]> = {
  github: [
    { key: 'repo', label: 'Repository', kind: 'text', placeholder: 'owner/name', help: 'The repository whose issues are yours.' },
    { key: 'logins', label: 'Logins', kind: 'list', help: 'GitHub logins, one per line. An issue assigned to any of them is yours.' },
    { key: 'project.owner', label: 'Project owner', kind: 'text', help: 'The owner of the project board.' },
    { key: 'project.number', label: 'Project number', kind: 'integer', help: 'The project board number.' },
    { key: 'project.statusField', label: 'Status field', kind: 'text', placeholder: 'Status', help: 'The project field that holds the status.' },
    { key: 'assignedStatuses', label: 'Assigned statuses', kind: 'list', help: 'Project statuses that make an issue yours, one per line.' },
    { key: 'branchPattern', label: 'Branch pattern', kind: 'text', placeholder: '^(\\d+)-', help: 'A regular expression whose first group is the issue number a worktree branch names.' },
    { key: 'ghPath', label: 'gh path', kind: 'text', placeholder: 'gh', help: 'The gh executable.' },
    { key: 'maxPages', label: 'Page limit', kind: 'integer', placeholder: '5', help: 'A poll that needs more pages of 100 issues fails.' },
  ],
  zoho: [
    { key: 'orgId', label: 'Organization ID', kind: 'text', help: 'The Desk organization ID.' },
    { key: 'agentId', label: 'Agent ID', kind: 'text', help: 'Your Zoho agent ID.' },
    { key: 'tokenCommand', label: 'Token command', kind: 'text', placeholder: 'bash ~/.claude/scripts/desk-token.sh', help: 'Prints a Desk access token. Runs in Git Bash.' },
    { key: 'apiBase', label: 'API base', kind: 'text', placeholder: 'https://desk.zoho.com/api/v1', help: 'The Desk REST API.' },
    { key: 'escalationField', label: 'Escalation field', kind: 'text', placeholder: 'cf_queue', help: 'The custom field that holds the escalation tier.' },
    { key: 'escalationValue', label: 'Escalation value', kind: 'text', placeholder: 'Support', help: 'The escalation tier that puts a ticket in scope.' },
    {
      key: 'automationAgentIds',
      label: 'Automation agent IDs',
      kind: 'list',
      listDefault: ['8000000000000000002', '8000000000000000003'],
      help: 'Agents whose hold on a ticket is not a claim, one per line. Empty means none.',
    },
    { key: 'maxPages', label: 'Page limit', kind: 'integer', placeholder: '20', help: 'A poll that needs more pages fails.' },
  ],
  forum: [
    { key: 'userId', label: 'User ID', kind: 'text', help: 'Your forum user ID.' },
    { key: 'forumId', label: 'Forum ID', kind: 'integer', placeholder: '11', help: 'The Forum forum ID.' },
    { key: 'queryCommand', label: 'Query command', kind: 'text', placeholder: 'bash ~/.claude/scripts/run-forum-sql.sh', help: 'Runs SQL from stdin against the forum database. Runs in Git Bash.' },
    { key: 'maxRows', label: 'Row limit', kind: 'integer', placeholder: '500', help: 'A poll that returns this many open topics is incomplete.' },
    { key: 'auditDatabase', label: 'Audit database', kind: 'text', placeholder: 'audit', help: 'The change-history database on the same host.' },
  ],
};

export function sourceFields(state: EditorState, name: string): { heading: string; fields: Field[] }[] {
  const base = `sources.${name}`;
  const value = settingsValue(state);
  const triagePlaybooks = state.config.playbooks.filter((entry) => entry.playbook?.kind === 'triage').map((entry) => ({ value: entry.name, label: entry.name }));
  const common: Field[] = [
    { path: `${base}.enabled`, label: 'Poll this source', kind: 'boolean', fallback: false, help: 'A disabled source is not polled and its pool is hidden. Its work items stay.' },
    { path: `${base}.pollIntervalSeconds`, label: 'Poll interval (seconds)', kind: 'integer', placeholder: '300', help: 'At least 10.' },
    { path: `${base}.repoRoot`, label: 'Repo root', kind: 'text', help: 'The repository sessions run in when the ticket has no worktree.' },
    {
      path: `${base}.namespace`,
      label: 'Namespace',
      kind: 'select',
      options: withCurrent([{ value: '', label: 'Every namespace' }, ...namespaces(state).map((entry) => ({ value: entry, label: entry }))], getAt(value, `${base}.namespace`)),
      help: 'Triage chooses among this namespace’s task playbooks.',
    },
    {
      path: `${base}.triagePlaybook`,
      label: 'Triage playbook',
      kind: 'select',
      options: withCurrent([{ value: '', label: 'None' }, ...triagePlaybooks], getAt(value, `${base}.triagePlaybook`)),
      help: 'The classifier’s instructions for this source.',
    },
    { path: `${base}.setupPrompt`, label: 'Setup prompt', kind: 'prompt', help: 'Runs before a playbook that requires a worktree, when the ticket has none.' },
  ];

  if (POOL_SOURCES.has(name)) {
    common.push({ path: `${base}.pickPrompt`, label: 'Pick prompt', kind: 'prompt', help: 'Runs when you start a pool ticket, to claim it for you.' });
  }

  const options = (OPTION_FIELDS[name] ?? []).map(({ key, ...field }) => ({ ...field, path: `${base}.${key}` }));

  return options.length === 0 ? [{ heading: 'Source', fields: common }] : [{ heading: 'Source', fields: common }, { heading: SOURCE_LABELS[name] ?? name, fields: options }];
}

export function playbookFields(state: EditorState, playbook: PlaybookFields): Field[] {
  const sessions = settingsValue(state);
  const mode = getAt(sessions, 'sessions.permissionMode');
  const model = getAt(sessions, 'sessions.model');
  const fields: Field[] = [
    { path: 'description', label: 'Description', kind: 'text', help: 'Tells triage when to choose this playbook. One line.' },
    {
      path: 'kind',
      label: 'Kind',
      kind: 'select',
      options: [
        { value: 'task', label: 'task' },
        { value: 'triage', label: 'triage' },
      ],
      help: 'A triage playbook holds a source’s classifier instructions and is never chosen for work.',
    },
  ];

  if (playbook.kind === 'task') {
    fields.push(
      { path: 'autoStart', label: 'Start automatically', kind: 'boolean', help: 'Start the session after triage. Off, the work item waits in Unstarted for you to start it.' },
      { path: 'requiresWorktree', label: 'Requires a worktree', kind: 'boolean', help: 'Run the source’s setup prompt first when the ticket has no worktree.' },
      {
        path: 'workdir',
        label: 'Working directory',
        kind: 'select',
        options: [
          { value: 'worktree', label: 'The ticket’s worktree, else the repo root' },
          { value: 'repoRoot', label: 'Always the source’s repo root' },
        ],
        help: 'Where the session runs.',
      },
      {
        path: 'permissionMode',
        label: 'Permission mode',
        kind: 'select',
        options: [{ value: '', label: `Sessions setting (${typeof mode === 'string' ? mode : 'auto'})` }, ...state.config.permissionModes.map((entry) => ({ value: entry, label: entry }))],
        help: 'Claude Code permission mode for this playbook’s sessions.',
      },
      {
        path: 'model',
        label: 'Model',
        kind: 'text',
        placeholder: `Sessions setting (${typeof model === 'string' && model !== '' ? model : 'Claude’s default'})`,
        help: 'The model for this playbook’s sessions.',
      },
    );
  }

  fields.push({
    path: 'template',
    label: playbook.kind === 'triage' ? 'Classifier instructions' : 'Prompt',
    kind: 'prompt',
    help:
      playbook.kind === 'triage'
        ? 'The classifier’s system prompt. {{playbooks}} inserts the task playbooks as “- name: description” lines; without it, triage appends them.'
        : `Variables: ${state.config.templateVariables.map((name) => `{{${name}}}`).join(' ')}. Switchboard adds the report commands after it.`,
  });

  return fields;
}

/**
 * The field an error names, by the longest path it contains. Under `sources`, a parent path such as `sources.github.project`
 * or `sources.github` names its first field.
 */
export function fieldOfError(error: string, paths: string[]): string | null {
  // The path stands alone: not part of a longer path, though a sentence's final period may follow it.
  const names = (path: string) => new RegExp(`(^|[^\\w.])${path.replaceAll('.', '\\.')}($|[^\\w.]|\\.(\\s|$))`).test(error);
  let best: { path: string; length: number } | null = null;

  for (const path of paths) {
    const segments = path.split('.');
    const shortest = segments[0] === 'sources' ? 2 : segments.length;

    for (let length = segments.length; length >= shortest; length--) {
      const candidate = segments.slice(0, length).join('.');

      if (names(candidate) && (best === null || length > best.length)) {
        best = { path, length };
      }
    }
  }

  return best?.path ?? null;
}

/** The field a playbook error names: the key it starts with, or the template. */
export function playbookFieldOfError(error: string, paths: string[]): string | null {
  return paths.find((path) => error.startsWith(`${path} `)) ?? (/template/i.test(error) ? 'template' : null);
}

function fieldHtml(field: Field, value: unknown, errors: string[], id: string): string {
  const attrs = `id="${id}" data-field="${escape(field.path)}" data-kind="${field.kind}"${field.listDefault === undefined ? '' : ' data-keep-empty'}`;
  const placeholder = field.placeholder === undefined ? '' : ` placeholder="${escape(field.placeholder)}"`;
  const text = value === undefined && field.listDefault !== undefined ? field.listDefault.join('\n') : value === undefined || value === null ? '' : Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : JSON.stringify(value);
  let control: string;

  switch (field.kind) {
    case 'boolean': {
      const checked = typeof value === 'boolean' ? value : field.fallback === true;

      control = `<label class="check"><input type="checkbox" ${attrs}${checked ? ' checked' : ''}> ${escape(field.label)}</label>`;
      break;
    }
    case 'select': {
      const options = field.options ?? [];
      const selected = typeof value === 'string' ? value : (field.placeholder ?? '');

      control = `<select ${attrs}>${options.map((option) => `<option value="${escape(option.value)}"${option.value === selected ? ' selected' : ''}>${escape(option.label)}</option>`).join('')}</select>`;
      break;
    }
    case 'list':
      control = `<textarea rows="${Math.max(2, text.split('\n').length + 1)}" ${attrs}${placeholder}>${escape(text)}</textarea>`;
      break;
    case 'prompt':
      control = `<textarea class="prompt" rows="${Math.min(30, Math.max(3, text.split('\n').length + 1))}" ${attrs}${placeholder}>${escape(text)}</textarea>`;
      break;
    default:
      control = `<input type="text" ${attrs}${placeholder} value="${escape(text)}">`;
  }

  const label = field.kind === 'boolean' ? '' : `<label class="label" for="${id}">${escape(field.label)}</label>`;
  const errorList = `<div class="field-errors" data-errors-for="${escape(field.path)}">${errors.map((error) => `<p class="error">${escape(error)}</p>`).join('')}</div>`;

  return `<div class="field${errors.length > 0 ? ' invalid' : ''}">${label}${control}<p class="help">${escape(field.help)}</p>${errorList}</div>`;
}

function errorsFor(errors: string[], path: string, mapper: (error: string) => string | null): string[] {
  return errors.filter((error) => mapper(error) === path);
}

export function allSettingsPaths(state: EditorState): string[] {
  const value = settingsValue(state);
  const sources = isObject(value) && isObject(value['sources']) ? Object.keys(value['sources']) : [];

  return [...generalFields(state), ...sources.flatMap((name) => sourceFields(state, name))].flatMap((section) => section.fields.map((field) => field.path));
}

/** The page that holds each settings error's field; errors with no field show on every settings page. */
export function settingsErrorPages(state: EditorState): Map<string, PageId | null> {
  const paths = allSettingsPaths(state);

  return new Map(
    state.settingsErrors.map((error) => {
      const path = fieldOfError(error, paths);

      return [error, path === null ? null : path.startsWith('sources.') ? (`source:${path.split('.')[1]}` as PageId) : 'general'];
    }),
  );
}

function pageHasErrors(state: EditorState, page: PageId): boolean {
  if (page.startsWith('playbook:')) {
    const name = page.slice('playbook:'.length);

    return (state.playbookErrors.get(name)?.length ?? 0) > 0 || (state.refusals.get(name)?.length ?? 0) > 0 || playbookFile(state, name)?.error != null;
  }

  // A refused settings save names no field, so the mark goes on Sessions and triage.
  return [...settingsErrorPages(state).values()].includes(page) || (page === 'general' && (state.refusals.get('settings')?.length ?? 0) > 0);
}

function pageDirty(state: EditorState, page: PageId): boolean {
  if (page.startsWith('playbook:')) {
    return playbookDirty(state, page.slice('playbook:'.length));
  }

  if (page === 'new-playbook') {
    return false;
  }

  const section = page === 'general' ? ['sessions', 'triage'] : [`sources.${page.slice('source:'.length)}`];

  return state.settingsDraft !== null && section.some((path) => JSON.stringify(getAt(state.settingsDraft!.value, path)) !== JSON.stringify(getAt(state.config.settings.value, path)));
}

function navItem(state: EditorState, page: PageId, label: string, extra = ''): string {
  const marks = `${pageDirty(state, page) ? '<span class="dot" title="Unsaved changes"></span>' : ''}${pageHasErrors(state, page) ? '<span class="codicon codicon-error" title="Has errors"></span>' : ''}`;

  return `<button class="nav-item${state.page === page ? ' current' : ''}" data-command="navigate" data-arg="${escape(page)}"><span class="nav-label">${label}</span>${extra}${marks}</button>`;
}

export function renderNav(state: EditorState): string {
  const value = settingsValue(state);
  const sources = isObject(value) && isObject(value['sources']) ? Object.entries(value['sources']) : [];
  const missing = state.config.sourceKinds.filter((kind) => !sources.some(([name]) => name === kind));
  const byNamespace = new Map<string, string[]>();

  const names = [...new Set([...state.config.playbooks.map((entry) => entry.name), ...state.playbookDrafts.keys()])].sort();

  for (const full of names) {
    const [namespace = '', name = ''] = full.split(':');

    byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), name]);
  }

  const sourceItems = sources
    .map(([name, source]) => navItem(state, `source:${name}`, escape(SOURCE_LABELS[name] ?? name), isObject(source) && source['enabled'] === true ? '' : '<span class="muted">off</span>'))
    .join('');
  const addItems = missing
    .map((kind) => `<button class="nav-item add" data-command="add-source" data-arg="${escape(kind)}"><span class="codicon codicon-add"></span><span class="nav-label">Add ${escape(SOURCE_LABELS[kind] ?? kind)}</span></button>`)
    .join('');
  const playbookItems = [...byNamespace.entries()]
    .map(([namespace, names]) => `<p class="nav-namespace">${escape(namespace)}</p>${names.map((name) => navItem(state, `playbook:${namespace}:${name}`, escape(name))).join('')}`)
    .join('');

  return `<nav>
<p class="nav-heading">Settings</p>${navItem(state, 'general', 'Sessions and triage')}
<p class="nav-heading">Sources</p>${sourceItems}${addItems}
<p class="nav-heading">Playbooks</p>${playbookItems}
<button class="nav-item add${state.page === 'new-playbook' ? ' current' : ''}" data-command="navigate" data-arg="new-playbook"><span class="codicon codicon-add"></span><span class="nav-label">New playbook</span></button>
</nav>`;
}

function header(title: string, path: string | null, buttons: string): string {
  const file = path === null ? '' : `<button class="link" data-command="open-file" data-arg="${escape(path)}" title="Open the file in an editor">${escape(path)}</button>`;

  return `<header><div><h2>${title}</h2>${file}</div><div class="buttons">${buttons}</div></header>`;
}

function saveAllButton(state: EditorState): string {
  return `<button data-command="save-all" title="Save settings.json and every changed playbook"${anyDirty(state) ? '' : ' disabled'}>Save all</button>`;
}

function saveButtons(state: EditorState, dirty: boolean, extra = ''): string {
  return `${extra}<button data-command="revert"${dirty ? '' : ' disabled'}>Revert</button>${saveAllButton(state)}<button class="primary" data-command="save"${dirty ? '' : ' disabled'}>Save</button>`;
}

function errorBlock(errors: string[]): string {
  return `<div class="page-errors">${errors.map((error) => `<p class="error"><span class="codicon codicon-error"></span>${escape(error)}</p>`).join('')}</div>`;
}

function changedNote(changed: boolean, file: string, deleted = false): string {
  const text = deleted ? `${file} was deleted on disk. Save creates it again; Revert discards your changes.` : `${file} changed on disk. Revert to load it, or Save to see the refusal.`;

  return changed ? `<p class="note changed"><span class="codicon codicon-warning"></span>${escape(text)}</p>` : '';
}

function renderSettingsPage(state: EditorState, title: string, sections: { heading: string; fields: Field[] }[], extraButtons = ''): string {
  const { settings } = state.config;
  const value = settingsValue(state);

  if (value === null) {
    return `${header(title, settings.path, '')}${errorBlock([settings.error ?? 'settings.json must contain an object.'])}<p>Fix the file in an editor; the editor reloads it when it changes.</p>`;
  }

  const paths = allSettingsPaths(state);
  const pages = settingsErrorPages(state);
  const loose = [...(state.refusals.get('settings') ?? []), ...state.settingsErrors.filter((error) => pages.get(error) === null)];
  const body = sections
    .map(
      (section) =>
        `<section><h3>${escape(section.heading)}</h3>${section.fields
          .map((field, index) => fieldHtml(field, getAt(value, field.path), errorsFor(state.settingsErrors, field.path, (error) => fieldOfError(error, paths)), `f-${section.heading}-${index}`.replace(/\W/g, '-')))
          .join('')}</section>`,
    )
    .join('');
  const changed = state.settingsDraft !== null && state.settingsDraft.version !== settings.version;

  return `${header(title, settings.path, saveButtons(state, settingsDirty(state), extraButtons))}${changedNote(changed, 'settings.json')}${errorBlock(loose)}${body}`;
}

/** `extra` errors show at the top of the page with the errors that name no field. */
function renderPlaybookFields(state: EditorState, playbook: PlaybookFields, errors: string[], extra: string[] = []): string {
  const fields = playbookFields(state, playbook);
  const paths = fields.map((field) => field.path);
  const loose = [...extra, ...errors.filter((error) => playbookFieldOfError(error, paths) === null)];

  return `${errorBlock(loose)}<section>${fields
    .map((field, index) => fieldHtml(field, playbook[field.path as keyof PlaybookFields], errorsFor(errors, field.path, (error) => playbookFieldOfError(error, paths)), `p-${index}`))
    .join('')}</section>`;
}

export function renderPage(state: EditorState): string {
  const { page } = state;

  if (page === 'general') {
    return renderSettingsPage(state, 'Sessions and triage', generalFields(state));
  }

  if (page.startsWith('source:')) {
    const name = page.slice('source:'.length);
    const unknown = state.config.sourceKinds.includes(name) ? '' : `<p class="note"><span class="codicon codicon-warning"></span>Switchboard has no source named ${escape(name)}.</p>`;

    return unknown + renderSettingsPage(state, `${escape(SOURCE_LABELS[name] ?? name)} <span class="muted">sources.${escape(name)}</span>`, sourceFields(state, name), `<button data-command="remove-source" data-arg="${escape(name)}">Remove source</button>`);
  }

  if (page === 'new-playbook') {
    const draft = state.newPlaybook;
    const nameError = draft.namespace === '' && draft.name === '' && !draft.touched ? null : newNameError(state);
    const names = `<section><div class="field-row">
<div class="field"><label class="label" for="new-namespace">Namespace</label><input type="text" id="new-namespace" data-new="namespace" list="namespaces" value="${escape(draft.namespace)}" placeholder="dev"><datalist id="namespaces">${namespaces(state).map((entry) => `<option value="${escape(entry)}">`).join('')}</datalist></div>
<div class="field"><label class="label" for="new-name">Name</label><input type="text" id="new-name" data-new="name" value="${escape(draft.name)}" placeholder="develop"></div>
</div><p class="help">The file is playbooks/&lt;namespace&gt;/&lt;name&gt;.md. Lowercase letters, digits and hyphens.</p><div class="field-errors" data-errors-for="name">${nameError === null ? '' : `<p class="error">${escape(nameError)}</p>`}</div></section>`;

    return `${header('New playbook', null, `${saveAllButton(state)}<button class="primary" data-command="create">Create</button>`)}${names}${renderPlaybookFields(state, draft.playbook, state.playbookErrors.get('new') ?? [], state.refusals.get('new') ?? [])}`;
  }

  const name = page.slice('playbook:'.length);
  const file = playbookFile(state, name);
  const draft = state.playbookDrafts.get(name);
  const errors = state.playbookErrors.get(name) ?? [];
  const refused = state.refusals.get(name) ?? [];

  if (file === null && draft === undefined) {
    return `${header(escape(name), null, '')}${errorBlock(refused)}<p>This playbook no longer exists.</p>`;
  }

  const deleteButton = file === null ? '' : '<button data-command="delete">Delete</button>';

  // An invalid file is fixed by hand; a draft started before the file broke stays editable.
  if (draft === undefined && file?.playbook === null) {
    return `${header(escape(name), file.path, deleteButton)}${errorBlock([file.error ?? 'The file is invalid.', ...refused])}<p>Fix the file in an editor; the editor reloads it when it changes.</p>`;
  }

  const changed = draft !== undefined && (file === null || draft.version !== file.version);
  const broken = draft !== undefined && file?.playbook === null ? [`On disk: ${file.error ?? 'The file is invalid.'}`] : [];

  return `${header(escape(name), file?.path ?? null, saveButtons(state, playbookDirty(state, name), deleteButton))}${changedNote(changed, name, file === null)}${renderPlaybookFields(state, playbookValue(state, name)!, errors, [...refused, ...broken])}`;
}

export function renderEditor(state: EditorState): string {
  return `${renderNav(state)}<main>${renderPage(state)}</main>`;
}
