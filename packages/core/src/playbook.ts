import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSION_MODES } from './settings.js';
import type { PermissionMode } from './settings.js';

/** The reports a task playbook can offer its session; stage and link are always offered (PRD R23). */
export const PLAYBOOK_REPORTS = ['done', 'approval', 'worktree', 'playbook', 'paste'] as const;
export type PlaybookReport = (typeof PLAYBOOK_REPORTS)[number];

export interface Playbook {
  /** `<namespace>:<name>`, from the file's path. */
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
  template: string;
}

export interface PlaybookError {
  /** The file, relative to the playbook directory. */
  file: string;
  error: string;
}

export type PlaybookResult = { playbook: Playbook } | { error: string };

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const KEYS = ['description', 'kind', 'autoStart', 'requiresWorktree', 'permissionMode', 'model', 'workdir', 'reports', 'approvalSends', 'rates'];

function parseFrontMatter(text: string): { fields: Map<string, string>; body: string } | { error: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n')) {
    return { error: 'The file must start with front matter between --- lines.' };
  }

  const end = normalized.indexOf('\n---', 3);

  if (end === -1 || (normalized[end + 4] !== undefined && normalized[end + 4] !== '\n')) {
    return { error: 'The front matter has no closing --- line.' };
  }

  const fields = new Map<string, string>();

  for (const line of normalized.slice(4, end + 1).split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }

    const match = /^([A-Za-z]+):\s*(.*?)\s*$/.exec(line);

    if (match === null) {
      return { error: `Front matter line is not "key: value": ${line}` };
    }

    const [, key = '', raw = ''] = match;
    const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw);

    if (fields.has(key)) {
      return { error: `Front matter repeats ${key}.` };
    }

    fields.set(key, quoted?.[1] ?? raw);
  }

  return { fields, body: normalized.slice(end + 4).replace(/^\n/, '') };
}

function flag(fields: Map<string, string>, key: string): boolean | { error: string } {
  const value = fields.get(key);

  if (value === undefined || value === 'false') {
    return false;
  }

  return value === 'true' ? true : { error: `${key} must be true or false.` };
}

/** Parses a playbook file. `name` is `<namespace>:<name>`. */
export function parsePlaybook(name: string, text: string): PlaybookResult {
  const parsed = parseFrontMatter(text);

  if ('error' in parsed) {
    return parsed;
  }

  const { fields, body } = parsed;
  const unknown = [...fields.keys()].filter((key) => !KEYS.includes(key));

  if (unknown.length > 0) {
    return { error: `Unknown front matter: ${unknown.join(', ')}.` };
  }

  const description = fields.get('description') ?? '';

  if (description === '') {
    return { error: 'description is required.' };
  }

  const kind = fields.get('kind') ?? 'task';

  if (kind !== 'task' && kind !== 'triage') {
    return { error: 'kind must be task or triage.' };
  }

  const autoStart = flag(fields, 'autoStart');
  const requiresWorktree = flag(fields, 'requiresWorktree');
  const rates = flag(fields, 'rates');
  const approvalSends = flag(fields, 'approvalSends');

  if (typeof autoStart !== 'boolean') {
    return autoStart;
  }

  if (typeof requiresWorktree !== 'boolean') {
    return requiresWorktree;
  }

  if (typeof rates !== 'boolean') {
    return rates;
  }

  if (typeof approvalSends !== 'boolean') {
    return approvalSends;
  }

  if (kind === 'task' && rates) {
    return { error: 'rates applies only to a triage playbook.' };
  }

  const permissionMode = fields.get('permissionMode') ?? null;

  if (permissionMode !== null && !(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    return { error: `permissionMode must be one of ${PERMISSION_MODES.join(', ')}.` };
  }

  const workdir = fields.get('workdir') ?? 'worktree';

  if (workdir !== 'worktree' && workdir !== 'repoRoot') {
    return { error: 'workdir must be worktree or repoRoot.' };
  }

  const reports = (fields.get('reports') ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
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

  if (body.trim() === '') {
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
      model: fields.get('model') || null,
      workdir,
      reports: PLAYBOOK_REPORTS.filter((entry) => reports.includes(entry)),
      approvalSends,
      rates,
      template: body,
    },
  };
}

export type PlaybookFields = Omit<Playbook, 'name'>;

/** A front matter value, quoted when the parser would otherwise trim it or strip its quotes. */
function frontMatterValue(value: string): string {
  return value !== value.trim() || /^["']/.test(value) ? `"${value}"` : value;
}

/**
 * Writes a playbook file that {@link parsePlaybook} reads back with the same fields; the template gains a final newline.
 * Defaults are left out, except a task playbook's `autoStart` and `requiresWorktree`. Front matter comments are not kept.
 */
export function formatPlaybook(playbook: PlaybookFields): { text: string } | { error: string } {
  for (const [key, value] of Object.entries({ description: playbook.description, model: playbook.model ?? '' })) {
    if (/[\r\n]/.test(value)) {
      return { error: `${key} must be one line.` };
    }
  }

  const lines = [`description: ${frontMatterValue(playbook.description)}`];

  if (playbook.kind === 'triage') {
    lines.push('kind: triage');
  }

  if (playbook.kind === 'triage' && playbook.rates) {
    lines.push('rates: true');
  }

  for (const key of ['autoStart', 'requiresWorktree'] as const) {
    if (playbook.kind === 'task' || playbook[key]) {
      lines.push(`${key}: ${playbook[key]}`);
    }
  }

  if (playbook.workdir !== 'worktree') {
    lines.push(`workdir: ${playbook.workdir}`);
  }

  if (playbook.kind === 'task' && playbook.reports.length > 0) {
    lines.push(`reports: ${playbook.reports.join(', ')}`);
  }

  if (playbook.kind === 'task' && playbook.reports.includes('approval') && playbook.approvalSends) {
    lines.push('approvalSends: true');
  }

  if (playbook.permissionMode !== null) {
    lines.push(`permissionMode: ${playbook.permissionMode}`);
  }

  if (playbook.model !== null && playbook.model !== '') {
    lines.push(`model: ${frontMatterValue(playbook.model)}`);
  }

  const body = playbook.template.replace(/\r\n/g, '\n');

  return { text: `---\n${lines.join('\n')}\n---\n${body.endsWith('\n') ? body : `${body}\n`}` };
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

export interface PlaybookFile {
  /** `<namespace>:<name>`, from the path, which may not be a valid playbook name. */
  name: string;
  /** Relative to the playbook directory, such as `dev/develop.md`. */
  file: string;
  path: string;
}

/** The `<dir>/<namespace>/<name>.md` files, sorted. A missing directory has none. */
export function listPlaybookFiles(dir: string): PlaybookFile[] {
  let namespaces: string[];

  try {
    namespaces = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  return namespaces.flatMap((namespace) =>
    readdirSync(join(dir, namespace), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
      .map((file) => ({ name: `${namespace}:${file.slice(0, -'.md'.length)}`, file: `${namespace}/${file}`, path: join(dir, namespace, file) })),
  );
}

/** Parses one listed playbook file's text. */
export function parsePlaybookFile(file: PlaybookFile, text: string): PlaybookResult {
  return isPlaybookName(file.name) ? parsePlaybook(file.name, text) : { error: 'Namespace and name must be lowercase letters, digits and hyphens.' };
}

/** Reads `<dir>/<namespace>/<name>.md`. An invalid file is left out and reported (PRD R42). A missing directory is empty. */
export function loadPlaybooks(dir: string): PlaybookSet {
  const playbooks = new Map<string, Playbook>();
  const errors: PlaybookError[] = [];

  for (const file of listPlaybookFiles(dir)) {
    const result = parsePlaybookFile(file, readFileSync(file.path, 'utf8'));

    if ('error' in result) {
      errors.push({ file: file.file, error: result.error });
    } else {
      playbooks.set(result.playbook.name, result.playbook);
    }
  }

  return { playbooks, errors };
}
