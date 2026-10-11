import { PERMISSION_MODES } from './settings.js';
import type { PermissionMode } from './settings.js';

/** The reports a task playbook can offer its session; stage and link are always offered (PRD R23). */
export const PLAYBOOK_REPORTS = ['done', 'approval', 'worktree', 'playbook', 'paste'] as const;
export type PlaybookReport = (typeof PLAYBOOK_REPORTS)[number];

export interface Playbook {
  /** `<namespace>:<name>`, its key under `playbooks` in settings.json. */
  name: string;
  description: string;
  kind: 'task' | 'triage';
  autoStart: boolean;
  requiresWorktree: boolean;
  /** Null takes the `sessions` setting. */
  permissionMode: PermissionMode | null;
  model: string | null;
  /** `worktree`: the ticket's worktree when one exists, else the repo root. `repoRoot`: always the source's repo root. */
  workdir: 'worktree' | 'repoRoot';
  /** Empty by default: the session's turn then ends finished, in Ready for review. */
  reports: PlaybookReport[];
  /** Approve sends the session's work, such as posting a reply or pushing a branch; the dock marks the approval row `send`, else `review` (PRD R27). */
  approvalSends: boolean;
  /** A triage playbook's classifier rates immediacy and severity (PRD R50); without it, triage stores neither. */
  rates: boolean;
  /** Playbooks whose work this one's work comes back to, such as `dev:review-pr` for `dev:review-pr-followup`; Returned counts them too (PRD R51). */
  returnOf: string[];
  template: string;
}

export interface PlaybookError {
  /** The key under `playbooks`, which may not be a valid playbook name. */
  name: string;
  error: string;
}

export type PlaybookResult = { playbook: Playbook } | { error: string };

export type PlaybookFields = Omit<Playbook, 'name'>;

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const KEYS = ['description', 'kind', 'autoStart', 'requiresWorktree', 'permissionMode', 'model', 'workdir', 'reports', 'approvalSends', 'rates', 'returnOf', 'template'];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flag(entry: Json, key: string): boolean | { error: string } {
  const value = entry[key] ?? false;

  return typeof value === 'boolean' ? value : { error: `${key} must be true or false.` };
}

function text(entry: Json, key: string): string | null | { error: string } {
  const value = entry[key] ?? null;

  return value === null || typeof value === 'string' ? value : { error: `${key} must be a string.` };
}

function list(entry: Json, key: string): string[] | { error: string } {
  const value = entry[key] ?? [];

  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : { error: `${key} must be a list of strings.` };
}

/** Parses one entry under `playbooks` in settings.json. `name` is its key, `<namespace>:<name>`. */
export function parsePlaybook(name: string, value: unknown): PlaybookResult {
  if (!isPlaybookName(name)) {
    return { error: 'Namespace and name must be lowercase letters, digits and hyphens.' };
  }

  if (!isObject(value)) {
    return { error: 'A playbook must be an object.' };
  }

  const unknown = Object.keys(value).filter((key) => !KEYS.includes(key));

  if (unknown.length > 0) {
    return { error: `Unknown keys: ${unknown.join(', ')}.` };
  }

  const strings = Object.fromEntries(['description', 'kind', 'permissionMode', 'model', 'workdir', 'template'].map((key) => [key, text(value, key)]));
  const flags = Object.fromEntries(['autoStart', 'requiresWorktree', 'rates', 'approvalSends'].map((key) => [key, flag(value, key)]));
  const lists = Object.fromEntries(['reports', 'returnOf'].map((key) => [key, list(value, key)]));
  const invalid = [...Object.values(strings), ...Object.values(flags), ...Object.values(lists)].find((field) => field !== null && typeof field === 'object' && 'error' in field);

  if (invalid !== undefined) {
    return invalid as { error: string };
  }

  const description = strings['description'] as string | null;
  const kind = (strings['kind'] as string | null) ?? 'task';
  const permissionMode = strings['permissionMode'] as string | null;
  const model = strings['model'] as string | null;
  const workdir = (strings['workdir'] as string | null) ?? 'worktree';
  const template = (strings['template'] as string | null) ?? '';
  const [autoStart, requiresWorktree, rates, approvalSends] = ['autoStart', 'requiresWorktree', 'rates', 'approvalSends'].map((key) => flags[key] as boolean) as [boolean, boolean, boolean, boolean];
  const reports = lists['reports'] as string[];

  if (description === null || description === '') {
    return { error: 'description is required.' };
  }

  if (/[\r\n]/.test(description)) {
    return { error: 'description must be one line.' };
  }

  if (kind !== 'task' && kind !== 'triage') {
    return { error: 'kind must be task or triage.' };
  }

  if (kind === 'task' && rates) {
    return { error: 'rates applies only to a triage playbook.' };
  }

  if (permissionMode !== null && !(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    return { error: `permissionMode must be one of ${PERMISSION_MODES.join(', ')}.` };
  }

  if (workdir !== 'worktree' && workdir !== 'repoRoot') {
    return { error: 'workdir must be worktree or repoRoot.' };
  }

  const unknownReports = reports.filter((entry) => !(PLAYBOOK_REPORTS as readonly string[]).includes(entry));

  if (unknownReports.length > 0) {
    return { error: `reports can list ${PLAYBOOK_REPORTS.join(', ')}, not ${unknownReports.join(', ')}.` };
  }

  if (kind === 'triage' && reports.length > 0) {
    return { error: 'reports applies only to a task playbook.' };
  }

  if (approvalSends && !reports.includes('approval')) {
    return { error: 'approvalSends applies only to a playbook whose reports include approval.' };
  }

  const returnOf = [...new Set(lists['returnOf'] as string[])];
  const badReturnOf = returnOf.filter((entry) => !isPlaybookName(entry) || entry === name);

  if (badReturnOf.length > 0) {
    return { error: `returnOf must list other playbook names, not ${badReturnOf.join(', ')}.` };
  }

  if (kind === 'triage' && returnOf.length > 0) {
    return { error: 'returnOf applies only to a task playbook.' };
  }

  if (template.trim() === '') {
    return { error: 'The prompt template is empty.' };
  }

  return {
    playbook: {
      name,
      description,
      kind,
      autoStart,
      requiresWorktree,
      permissionMode: permissionMode as PermissionMode | null,
      model: model || null,
      workdir,
      reports: PLAYBOOK_REPORTS.filter((entry) => reports.includes(entry)),
      approvalSends,
      rates,
      returnOf,
      template,
    },
  };
}

/** Whether `name` is a valid `<namespace>:<name>` playbook name. */
export function isPlaybookName(name: string): boolean {
  const [namespace = '', base = '', ...rest] = name.split(':');

  return rest.length === 0 && SEGMENT.test(namespace) && SEGMENT.test(base);
}

export interface PlaybookSet {
  playbooks: Map<string, Playbook>;
  errors: PlaybookError[];
}

/**
 * Parses the `playbooks` object of settings.json; undefined has none. An invalid entry is left out and reported (PRD R42).
 * `parseSettings` rejects a `playbooks` value that is not an object.
 */
export function parsePlaybooks(value: unknown): PlaybookSet {
  const playbooks = new Map<string, Playbook>();
  const errors: PlaybookError[] = [];

  // Sorted by name, so the classifier's list does not depend on the order of the keys in the file.
  for (const [name, entry] of Object.entries(isObject(value) ? value : {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const result = parsePlaybook(name, entry);

    if ('error' in result) {
      errors.push({ name, error: result.error });
    } else {
      playbooks.set(name, result.playbook);
    }
  }

  return { playbooks, errors };
}
