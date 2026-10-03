import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSION_MODES } from './settings.js';
import type { PermissionMode } from './settings.js';

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
  template: string;
}

export interface PlaybookError {
  /** The file, relative to the playbook directory. */
  file: string;
  error: string;
}

export type PlaybookResult = { playbook: Playbook } | { error: string };

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const KEYS = ['description', 'kind', 'autoStart', 'requiresWorktree', 'permissionMode', 'model', 'workdir'];

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

  if (typeof autoStart !== 'boolean') {
    return autoStart;
  }

  if (typeof requiresWorktree !== 'boolean') {
    return requiresWorktree;
  }

  const permissionMode = fields.get('permissionMode') ?? null;

  if (permissionMode !== null && !(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    return { error: `permissionMode must be one of ${PERMISSION_MODES.join(', ')}.` };
  }

  const workdir = fields.get('workdir') ?? 'worktree';

  if (workdir !== 'worktree' && workdir !== 'repoRoot') {
    return { error: 'workdir must be worktree or repoRoot.' };
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
      template: body,
    },
  };
}

export interface PlaybookSet {
  playbooks: Map<string, Playbook>;
  errors: PlaybookError[];
}

/** Reads `<dir>/<namespace>/<name>.md`. An invalid file is left out and reported (PRD R42). A missing directory is empty. */
export function loadPlaybooks(dir: string): PlaybookSet {
  const playbooks = new Map<string, Playbook>();
  const errors: PlaybookError[] = [];
  let namespaces: string[];

  try {
    namespaces = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { playbooks, errors };
    }

    throw error;
  }

  for (const namespace of namespaces) {
    const files = readdirSync(join(dir, namespace), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort();

    for (const file of files) {
      const relative = `${namespace}/${file}`;
      const base = file.slice(0, -'.md'.length);

      if (!SEGMENT.test(namespace) || !SEGMENT.test(base)) {
        errors.push({ file: relative, error: 'Namespace and name must be lowercase letters, digits and hyphens.' });
        continue;
      }

      const result = parsePlaybook(`${namespace}:${base}`, readFileSync(join(dir, namespace, file), 'utf8'));

      if ('error' in result) {
        errors.push({ file: relative, error: result.error });
      } else {
        playbooks.set(result.playbook.name, result.playbook);
      }
    }
  }

  return { playbooks, errors };
}
